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
        .map_err(|_| "No API key set. Use the Set AI key button first.".to_string())?;

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
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last_err = String::from("Gemini request failed");

    // Retry transient overloads (503) and rate limits (429) with backoff.
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
                last_err = if e.is_timeout() {
                    "Gemini did not answer within 30 seconds. Try again.".to_string()
                } else {
                    e.without_url().to_string()
                };
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
