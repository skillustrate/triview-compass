# Security Review brief

Map trust boundaries, attacker-controlled inputs, assets, and sensitive state changed by the code. Trace input through validation, authorization, processing, storage, logs, and output. Check authentication, access control, injection, path handling, file upload, SSRF, secret exposure, privacy, dependency changes, and abuse of resource limits where relevant. Inspect failure paths as well as the intended path.

Do not infer that a prompt, client-side check, scanner, sandbox, or permission boundary is effective without supplied enforcement evidence. A changed dependency needs an evidence-backed risk, not a generic warning. Never repeat a secret value; cite its redaction marker or type. State attack preconditions, plausible impact, and a practical fix. If the supplied bundle cannot establish exploitability, say what remains unverified.
