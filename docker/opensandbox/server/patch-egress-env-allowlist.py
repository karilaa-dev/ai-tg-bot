from importlib.util import find_spec
from pathlib import Path


spec = find_spec("opensandbox_server.services.constants")
if spec is None or spec.origin is None:
    raise RuntimeError("could not locate OpenSandbox server constants module")

constants_path = Path(spec.origin)
source = constants_path.read_text()
required = (
    "OPENSANDBOX_EGRESS_DNS_UPSTREAM",
    "OPENSANDBOX_EGRESS_NAMESERVER_EXEMPT",
)

if all(f'"{name}"' in source for name in required):
    raise RuntimeError("upstream already permits the DNS egress variables; remove this compatibility patch")

anchor = '    "OPENSANDBOX_EGRESS_DNS_UPSTREAM_TIMEOUT",\n'
if source.count(anchor) != 1:
    raise RuntimeError("OpenSandbox egress allowlist anchor changed")

addition = "".join(f'    "{name}",\n' for name in required)
constants_path.write_text(source.replace(anchor, anchor + addition))
