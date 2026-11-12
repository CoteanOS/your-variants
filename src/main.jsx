import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Desktop app: the webview does not open outside links by itself, so hand
// them to the system browser.
if (window.__TAURI_INTERNALS__) {
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href^="https://"]');
    if (!a) return;
    e.preventDefault();
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("open_link", { url: a.href }).catch(() => {}),
    );
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
