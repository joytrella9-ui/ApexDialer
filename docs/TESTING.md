# Testing

```powershell
npm test          # unit + HTTP integration (Node test runner)
npm run test:e2e  # Playwright smoke (needs Chromium via playwright-core)
```

External providers are mocked or replaced with in-process fake adapters. Passing tests does not mean a live Twilio or OpenAI call succeeded.

CI: `.github/workflows/ci.yml`.
