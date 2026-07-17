# Release process

1. Feature branch → PR → required CI green
2. Merge to `main` (squash for readiness trains)
3. Staging deploy + smoke + canary matrix
4. Manual production approval
5. Deploy `prod-api` / `prod-worker` / `prod-widget`
6. Verify `/api/version`, health, widget IIFE
7. Rollback: Railway redeploy previous deployment ID; move widget alias only after smoke
