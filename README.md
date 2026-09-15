# ITCFun

Digital team boards for ITC Hitster Bingo. The app includes host/team modes, room codes, deterministic team boards, digital marking, bingo detection, Supabase persistence, and realtime round synchronization.

## Run locally

```bash
npm install
npm run dev
```

Create a local `.env` file with:

```text
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL Editor before creating rooms.

## Build

```bash
npm run build
```

## GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` deploys the `main` branch. In the GitHub repository, enable Pages with **GitHub Actions** as the source. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as repository secrets or variables, then update the workflow if the deployment needs to inject them during build.
