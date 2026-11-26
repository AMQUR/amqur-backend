# Off-volume encrypted backup job for AMQUR production (approval I1).
# Deployed as a Railway cron service in amqur-platform-staging; it never runs the application.
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends awscli openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
