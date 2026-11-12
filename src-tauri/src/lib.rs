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

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    key_entry()?
        .set_password(key.trim())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn has_api_key() -> bool {
    key_entry()
        .and_then(|e| e.get_password().map_err(|x| x.to_string()))
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

#[tauri::command]
async fn explain(system: String, prompt: String) -> Result<String, String> {
    let key = key_entry()?
        .get_password()
        .map_err(|_| "No API key set. Add your Gemini key in settings.".to_string())?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        GEMINI_MODEL, key
    );
    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 2048 }
    });

    let client = reqwest::Client::new();
    let mut last_err = String::from("Gemini request failed");

    // Retry transient overloads (503) and rate limits (429) with backoff,
    // same behaviour the old dev-server proxy had.
    for attempt in 0..4u64 {
        match client.post(&url).json(&body).send().await {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let data: GeminiResponse = match resp.json().await {
                    Ok(d) => d,
                    Err(e) => {
                        last_err = e.to_string();
                        break;
                    }
                };
                if let Some(err) = data.error {
                    last_err = err.message;
                    if status == 503 || status == 429 {
                        std::thread::sleep(std::time::Duration::from_millis(800 * (attempt + 1)));
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
                last_err = e.to_string();
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
        .invoke_handler(tauri::generate_handler![save_api_key, has_api_key, explain])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
