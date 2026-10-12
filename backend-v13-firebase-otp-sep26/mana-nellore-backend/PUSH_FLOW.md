# Backend Push Flow — Mana Nellore

Railway auto-deploys from GitHub (`lokesh8286235/Mana-Nellore`, root
`backend-v13-firebase-otp-sep26/mana-nellore-backend/`). Every backend change
follows these steps IN ORDER. No exceptions.

## Required steps before every push

1. **Run the smoke check** (REQUIRED — blocks the push on failure):
   ```bash
   cd ~/workspace/mana-nellore-backend && npm run smoke
   ```
   - Imports every module under `src/` and boots the real app with a mocked
     DB on an ephemeral port. Never touches production data or ports.
   - Exit 0 → safe to push. Exit non-zero → **DO NOT PUSH**. The output names
     the broken file; fix it and re-run until it passes.

2. **Push via the github skill** (full tree only — never a partial directory):
   ```bash
   python3 ~/workspace/skills/github/bin/gh.py push --subpath backend-v13-firebase-otp-sep26/mana-nellore-backend --dir ~/workspace/mana-nellore-backend
   ```
   (See `~/workspace/skills/github/SKILL.md` for exact flags. Fetch the recursive
   tree first, materialize every file, patch, then push.)

3. **Verify Railway actually serves the new code**:
   - `curl https://mana-nellore-mana-nellore.up.railway.app/api/health`
   - Exercise the changed endpoints (orders, OTP, maps, etc.) — a push is not
     done until the live server proves it.

## Why the smoke check exists

On 2026-10-09 a backend change with a broken startup sequence was pushed and
crashed on Railway. The smoke check (`smoke-check.js`) catches that class of
failure locally: any module that cannot be imported, or any startup sequence
that cannot boot, fails the check with the filename — before it ever reaches
Railway.
