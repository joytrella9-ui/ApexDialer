# Setup

See the root `README.md` for the canonical Windows setup.

```powershell
cd C:\Users\jajab\OneDrive\Desktop\ApexDialer
npm install
copy .env.example .env
npm start
```

Node 20+ recommended. The server defaults to `127.0.0.1:3210`.

First visit: create the operator (becomes **admin**). Forgot password: `npm run reset-operator` on this machine (hashes a new password in the local database; not a public reset flow).
