# Floop Captain — Android

Native Android shell for the Floop Captain rider app, built with Capacitor.

- **App ID:** `com.floop.captain`
- **Web UI:** `www/` (synced from the rider web build)
- **Background GPS:** TransistorSoft background-geolocation plugin — active only
  while the rider is online; stops on offline/logout/app terminate.

## Cloud builds

Every push to `main` (or manual run) builds a signed debug APK via GitHub Actions
and publishes it as the `floop-captain-apk` artifact. No local build machine needed.

Download: repo → Actions → latest green run → Artifacts → `floop-captain-apk`.

## Updating the web UI

1. Update the rider web source.
2. Copy `index.html`, `app.js`, `styles.css`, `version.txt` into `www/`.
3. Commit and push — the workflow rebuilds the APK automatically.
