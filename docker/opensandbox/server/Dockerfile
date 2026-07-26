FROM docker.io/opensandbox/server:v0.2.2

COPY patch-egress-env-allowlist.py /tmp/patch-egress-env-allowlist.py

RUN python /tmp/patch-egress-env-allowlist.py \
    && rm /tmp/patch-egress-env-allowlist.py \
    && python -c "from opensandbox_server.services.constants import ALLOWED_EGRESS_ENV_VARS; assert {'OPENSANDBOX_EGRESS_DNS_UPSTREAM', 'OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT'} <= ALLOWED_EGRESS_ENV_VARS"
