# PolicyLens Document AI Setup

PolicyLens is hosted on GitHub Pages, so Google Document AI must be called
through a server-side proxy. Do not paste a service account JSON key into
`index.html`, localStorage, or GitHub.

## 1. Processor Details

Use the Form Parser processor you created:

```text
Project ID: policylens-493014
Location: asia-southeast1
Processor ID: 5cd43d57e6998638
```

## 2. Deploy The Worker

The proxy code lives at:

```text
workers/document-ai-proxy.js
```

Create a Cloudflare Worker and set these variables/secrets:

```text
DOCUMENT_AI_PROJECT_ID=policylens-493014
DOCUMENT_AI_LOCATION=asia-southeast1
DOCUMENT_AI_PROCESSOR_ID=5cd43d57e6998638
POLICYLENS_ALLOWED_ORIGIN=https://fundlens-sg.github.io
```

Set this as a secret, not a plain variable:

```text
DOCUMENT_AI_SERVICE_ACCOUNT_JSON=<full service account JSON>
```

Optional, but recommended so random internet callers cannot spend your
Document AI credits:

```text
SUPABASE_URL=https://mgbxxwoasrwlraffcvab.supabase.co
SUPABASE_ANON_KEY=<PolicyLens Supabase anon key>
```

When these are set, the Worker only accepts requests with a valid signed-in
PolicyLens Supabase session.

The service account needs the Google Cloud role:

```text
Document AI API User
```

## 3. Connect PolicyLens

The live PolicyLens app defaults to this Worker URL:

```text
https://policylens-document-ai.chungakwanc.workers.dev
```

If you deploy a different Worker for testing, copy its URL, for example:

```text
https://policylens-document-ai.<your-subdomain>.workers.dev
```

Open PolicyLens:

```text
Settings -> AI Document Extraction -> Google Document AI Proxy
```

Paste the alternate Worker URL and click Save, then Test. Use Reset to return
to the built-in Worker URL.

## 4. Runtime Flow

For PDF/image scans, PolicyLens now tries:

```text
Google Document AI Form Parser
-> Gemini 2.5 Flash structured extraction
-> Claude fallback
```

Only the Document AI call is billed to your Google Cloud project through the
Worker. Gemini and Claude still use the keys saved in each user's PolicyLens
Settings for now.

If Document AI is not configured, does not support the file type, or fails,
PolicyLens falls back to the existing Gemini/Claude raw-file pipeline.

Excel files are still parsed locally with SheetJS. They are not sent to
Document AI.
