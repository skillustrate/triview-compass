# Independent sandbox image scan (Phase 8)

An independent image scan against the pinned Podman sandbox image is required, published so an external user can verify the sandbox's trust boundary without re-deriving it themselves. SECURITY.md's "A container is defense in depth" boundary explicitly lists "image provenance" as something that matters; this is that evidence.

## What was scanned

The pinned image used by `src/adapters/sandbox/` for the Phase 4/5/6 sandbox verification probes (see STATE.md): `docker.io/library/python@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26` (tagged `python:3.13-slim-bookworm` at scan time, Debian 12.15 base).

This is **not** a dependency of triview-compass itself — it's the container image the opt-in rootless Podman runner executes already-sanitized reviewed source inside. It is unrelated to `evals/evidence/dependency-audit-2026-10-14.json`, which is this project's own `npm audit` of its JavaScript dependencies.

## Method

Used [trivy](https://github.com/aquasecurity/trivy) (0.76.0) via its official container image, not a host install, keeping the scan itself isolated and reproducible the same way the project's own sandbox runner avoids host-level tooling:

```sh
podman save docker.io/library/python@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26 \
  -o pinned-image.tar

podman run --rm \
  -v "$(pwd):/scan:ro" -v "$(pwd)/out:/out" -v "$(pwd)/cache:/root/.cache/trivy" \
  docker.io/aquasec/trivy:latest image --input /scan/pinned-image.tar \
  --format json --output /out/trivy-result.json
```

No Docker daemon socket was mounted and no host trivy binary was installed; the image is exported to a tarball and scanned from that file alone. The vulnerability database was pulled fresh from `mirror.gcr.io/aquasec/trivy-db:2` on the scan date.

## Result

[`trivy-python-3.13-slim-bookworm-2026-10-15.json`](trivy-python-3.13-slim-bookworm-2026-10-15.json) is a trimmed summary (severity counts, every `CRITICAL` finding, every Python-language-package finding) rather than trivy's full ~1.3MB raw JSON output, to keep this evidence file readable and git-friendly.

- **287 total vulnerabilities**: 5 Critical, 62 High, 119 Medium, 99 Low, 2 Unknown.
- **281 of 287** are Debian OS-package (`os-pkgs`) findings inherited from the upstream `python:3.13-slim-bookworm` image's base layer — not something this project's sandbox adapter controls beyond choosing which pinned digest to use. The 5 Critical findings are all OS packages: `libsqlite3-0` and `zlib1g` (no fix currently published upstream for either, per trivy) and three `perl-base`-related CVEs (a fix is published: `5.36.0-7+deb12u4`).
- **6 of 287** are Python-language-package (`python-pkg`) findings bundled in the image: `msgpack`, `setuptools`, and `urllib3`, all with published fixes.
- Full findings for both categories are in the summary JSON; see its `criticalFindings` and `pythonPackageFindings` arrays.

## What this does and doesn't mean for the sandbox's trust boundary

- This scan is evidence about the **pinned image's own package contents**, not about the Podman runner's isolation controls (rootless, no network, read-only root, seccomp, cgroup limits — see `src/adapters/sandbox/podman-preflight.js`/`podman-runner.js` and SECURITY.md). Those controls are unaffected by this result.
- None of these CVEs are known to be exploitable *through* the narrow interface the sandbox actually exposes to reviewed content (a read-only mount of included sanitized files plus a bounded scratch tmpfs, no network, no added capabilities) — this scan did not attempt to establish reachability, only presence.
- A pinned-by-digest image does not auto-update; rerunning this scan periodically (or on each requalification, alongside the existing CLI-version requalification practice) is the mechanism for catching newly disclosed CVEs in the pinned digest, not something the pinning itself does automatically.
- This is a point-in-time result tied to one trivy DB snapshot and one image digest. It supersedes nothing from earlier phases and isn't re-verified by `npm test`/`check:release`/`check:package` — those remain the deterministic, re-runnable checks; this is a one-off, dated piece of published evidence per the Phase 8 exit criteria.
