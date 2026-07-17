# Monthly maintenance

- Review error budgets / SLO (`docs/operations/slo.md`)
- Rotate JWT / widget secrets per `secret-rotation-log.md`
- Confirm Railway Postgres snapshots succeeded
- Re-run staging canary matrix
- Dependency audit (`npm audit --omit=dev`)
- Confirm no dealership origins added without verification
