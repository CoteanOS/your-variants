mod db;

use std::sync::Mutex;

use serde::Deserialize;

const GEMINI_MODEL: &str = "gemini-3.5-flash";
/// Used when the main model is overloaded or too slow.
const GEMINI_FALLBACK_MODEL: &str = "gemini-3.5-flash-lite";
const KEYRING_SERVICE: &str = "eu.coteanos.yourvariants";
const KEYRING_USER: &str = "gemini_api_key";

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<Candidate>>,
    error: Option<GeminiError>,
}
#[derive(Deserialize)]
struct Candidate {
    content: Option<Content>,
}
#[derive(Deserialize)]
struct Content {
    parts: Option<Vec<Part>>,
}
#[derive(Deserialize)]
struct Part {
    text: Option<String>,
}
#[derive(Deserialize)]
struct GeminiError {
    message: String,
}

fn key_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

/// The key is read from the OS keychain once per launch and then kept in
/// memory, so the system only asks for permission a single time.
static KEY_CACHE: Mutex<Option<String>> = Mutex::new(None);

fn load_key() -> Result<String, String> {
    let mut cache = KEY_CACHE.lock().map_err(|e| e.to_string())?;
    if let Some(key) = cache.as_ref() {
        return Ok(key.clone());
    }
    let key = key_entry()?
        .get_password()
        .map_err(|_| "No API key set. Use the Set AI key button first.".to_string())?;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("No API key set. Use the Set AI key button first.".to_string());
    }
    *cache = Some(key.clone());
    Ok(key)
}

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    key_entry()?.set_password(&key).map_err(|e| e.to_string())?;
    *KEY_CACHE.lock().map_err(|e| e.to_string())? = Some(key);
    Ok(())
}

#[tauri::command]
fn has_api_key() -> bool {
    load_key().is_ok()
}

/// Open a web link in the user's normal browser. Only https links are allowed.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    if !url.starts_with("https://") || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Only https links can be opened.".to_string());
    }
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// One request to one model. On failure returns the message and whether the
/// failure is a busy or slow server, which is worth another try.
async fn ask_model(
    client: &reqwest::Client,
    model: &str,
    key: &str,
    body: &serde_json::Value,
) -> Result<String, (String, bool)> {
    // The key travels in a header, never in the URL, so it cannot end up in
    // an error message or a log line.
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    );
    let resp = client
        .post(&url)
        .header("x-goog-api-key", key)
        .json(body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                (
                    "Gemini is slow right now and did not answer. Try again in a moment."
                        .to_string(),
                    true,
                )
            } else {
                (e.without_url().to_string(), false)
            }
        })?;
    let status = resp.status().as_u16();
    let busy = status == 503 || status == 429;
    let data: GeminiResponse = resp
        .json()
        .await
        .map_err(|e| (e.without_url().to_string(), busy))?;
    if let Some(err) = data.error {
        return Err((err.message, busy));
    }
    let text = data
        .candidates
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.content)
        .and_then(|c| c.parts)
        .map(|parts| parts.into_iter().filter_map(|p| p.text).collect::<String>())
        .unwrap_or_default();
    Ok(text.trim().to_string())
}

#[tauri::command]
async fn explain(system: String, prompt: String) -> Result<String, String> {
    let key = load_key()?;
    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 2048 }
    });
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    // Try the main model twice, then the lighter fallback twice. Anything
    // other than a busy or slow server (a bad key, for example) stops at once.
    let mut last_err = String::from("Gemini request failed");
    for model in [GEMINI_MODEL, GEMINI_FALLBACK_MODEL] {
        for attempt in 0..2u64 {
            match ask_model(&client, model, &key, &body).await {
                Ok(text) => return Ok(text),
                Err((msg, busy)) => {
                    last_err = msg;
                    if !busy {
                        return Err(last_err);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(800 * (attempt + 1)))
                        .await;
                }
            }
        }
    }
    Err(last_err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            has_api_key,
            explain,
            open_link,
            db::ensure_db,
            db::match_rsids
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
