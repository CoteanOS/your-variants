mod db;

use std::sync::Mutex;

use serde::Deserialize;

const GEMINI_MODEL: &str = "gemini-3.5-flash";
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

#[tauri::command]
async fn explain(system: String, prompt: String) -> Result<String, String> {
    let key = load_key()?;

    // The key travels in a header, never in the URL, so it cannot end up in
    // an error message or a log line.
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        GEMINI_MODEL
    );
    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 2048 }
    });

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last_err = String::from("Gemini request failed");

    // Retry transient overloads (503), rate limits (429) and one slow answer.
    for attempt in 0..4u64 {
        let sent = client
            .post(&url)
            .header("x-goog-api-key", key.trim())
            .json(&body)
            .send()
            .await;
        match sent {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let data: GeminiResponse = match resp.json().await {
                    Ok(d) => d,
                    Err(e) => {
                        last_err = e.without_url().to_string();
                        break;
                    }
                };
                if let Some(err) = data.error {
                    last_err = err.message;
                    if status == 503 || status == 429 {
                        tokio::time::sleep(std::time::Duration::from_millis(800 * (attempt + 1)))
                            .await;
                        continue;
                    }
                    return Err(last_err);
                }
                let text = data
                    .candidates
                    .and_then(|c| c.into_iter().next())
                    .and_then(|c| c.content)
                    .and_then(|c| c.parts)
                    .map(|parts| {
                        parts
                            .into_iter()
                            .filter_map(|p| p.text)
                            .collect::<String>()
                    })
                    .unwrap_or_default();
                return Ok(text.trim().to_string());
            }
            Err(e) => {
                if e.is_timeout() {
                    last_err = "Gemini is slow right now and did not answer. Try again in a moment."
                        .to_string();
                    // One more go on a slow answer, then give up.
                    if attempt == 0 {
                        continue;
                    }
                } else {
                    last_err = e.without_url().to_string();
                }
                break;
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
