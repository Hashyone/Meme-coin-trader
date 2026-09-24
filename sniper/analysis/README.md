# Analysis-first security mode

This project intentionally prevents live execution until the analysis pipeline proves a candidate is safe.

The pipeline checks:
- pool metadata and base-pair eligibility
- contract runtime bytecode for mint, freeze, burn and honeypot patterns
- rugcheck.xyz signals and liquidity depth confirmation
- malicious contract heuristics
- deterministic security decisions before any simulation or execution occurs

When the analysis is not safe, the bot rejects the pool and waits for more data rather than executing.
