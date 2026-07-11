# Rollout — Dial Auto Group pilot

1. Deploy backend + `prisma migrate deploy`
2. Configure vAuto feed URLs per rooftop
3. Keep `tekionIntegration=false` until credentials
4. Enable widget features gradually via tenant `featureFlags`
5. Monitor `GET /api/integrations/health` and `GET /api/metrics`
6. Rollback: redeploy previous image; feeds keep LKG inventory on failed imports
