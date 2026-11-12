//! ClinVar database for the desktop build.
//!
//! On first launch the compressed database is downloaded from a GitHub
//! Release, unpacked into the app's data folder and kept there. After that it
//! is opened read-only and queried here, natively. Only the database file is
//! fetched; nothing about the user's genome is sent anywhere.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

/// Where the app fetches the database. Change this line when a newer
/// database is uploaded as a new release.
const DB_URL: &str =
    "https://github.com/CoteanOS/your-variants/releases/download/db-2026-05-28/clinvar.sqlite.gz";
const DB_FILE: &str = "clinvar.sqlite";

#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(DB_FILE))
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Could not open the database: {e}"))
}

/// Download, unpack and verify the database, then move it into place.
async fn download_db(app: &AppHandle, path: &Path) -> Result<(), String> {
    let part = path.with_extension("sqlite.part");

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(DB_URL).send().await.map_err(|e| {
        format!(
            "Could not reach the database download. Check your connection. ({})",
            e.without_url()
        )
    })?;
    if !resp.status().is_success() {
        return Err(format!(
            "Database download failed with status {}.",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length().unwrap_or(0);

    let file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut unpack = flate2::write::GzDecoder::new(std::io::BufWriter::new(file));
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;

    loop {
        let chunk = resp
            .chunk()
            .await
            .map_err(|e| format!("Download interrupted. Try again. ({})", e.without_url()))?;
        let Some(bytes) = chunk else { break };
        unpack
            .write_all(&bytes)
            .map_err(|e| format!("Could not unpack the database: {e}"))?;
        received += bytes.len() as u64;
        if received - last_emit >= 1_000_000 {
            last_emit = received;
            let _ = app.emit("db-progress", Progress { received, total });
        }
    }
    let mut writer = unpack
        .finish()
        .map_err(|e| format!("Could not unpack the database: {e}"))?;
    writer.flush().map_err(|e| e.to_string())?;
    drop(writer);
    let _ = app.emit("db-progress", Progress { received, total });

    // Make sure what arrived is a usable database before keeping it.
    {
        let con = open_read_only(&part)?;
        con.query_row("SELECT 1 FROM variants LIMIT 1", [], |_| Ok(()))
            .map_err(|_| "The downloaded database is not usable. Try again.".to_string())?;
    }
    std::fs::rename(&part, path).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_meta(path: &Path) -> Result<Map<String, Value>, String> {
    let con = open_read_only(path)?;
    let mut out = Map::new();
    // Databases built before the meta table existed simply have none.
    let Ok(mut stmt) = con.prepare("SELECT key, value FROM meta") else {
        return Ok(out);
    };
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let key: String = row.get(0).map_err(|e| e.to_string())?;
        let value: String = row.get(1).map_err(|e| e.to_string())?;
        out.insert(key, Value::String(value));
    }
    Ok(out)
}

fn query_matches(path: &Path, rsids: &[i64]) -> Result<Vec<Value>, String> {
    let err = |e: rusqlite::Error| e.to_string();
    let mut con = open_read_only(path)?;

    // The temp table lives in memory; the database file itself stays read-only.
    con.execute_batch(
        "PRAGMA temp_store = MEMORY;
         CREATE TEMP TABLE _user_rsids (rsid INTEGER PRIMARY KEY);",
    )
    .map_err(err)?;
    {
        let tx = con.transaction().map_err(err)?;
        {
            let mut insert = tx
                .prepare("INSERT OR IGNORE INTO _user_rsids (rsid) VALUES (?1)")
                .map_err(err)?;
            for rsid in rsids {
                insert.execute(rusqlite::params![rsid]).map_err(err)?;
            }
        }
        tx.commit().map_err(err)?;
    }

    let mut stmt = con
        .prepare("SELECT v.* FROM variants v JOIN _user_rsids u ON v.rsid = u.rsid")
        .map_err(err)?;
    let names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
    let mut rows = stmt.query([]).map_err(err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        let mut obj = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let value = match row.get_ref(i).map_err(err)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Real(f) => serde_json::Number::from_f64(f)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
                ValueRef::Blob(_) => Value::Null,
            };
            obj.insert(name.clone(), value);
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

/// Make sure the database is on disk (downloading it on first launch) and
/// return its metadata. Emits `db-progress` events while downloading.
#[tauri::command]
pub async fn ensure_db(app: AppHandle) -> Result<Value, String> {
    let path = db_path(&app)?;
    let cached = path.exists();
    if !cached {
        download_db(&app, &path).await?;
    }
    let meta = tauri::async_runtime::spawn_blocking(move || read_meta(&path))
        .await
        .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({ "ok": true, "cached": cached, "meta": meta }))
}

/// Return every ClinVar row whose rsID is in the user's list.
#[tauri::command]
pub async fn match_rsids(app: AppHandle, rsids: Vec<i64>) -> Result<Vec<Value>, String> {
    let path = db_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || query_matches(&path, &rsids))
        .await
        .map_err(|e| e.to_string())?
}
