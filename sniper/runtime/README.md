# Continuous paper-trading runtime

This runtime keeps the bot alive after a candidate is processed instead of exiting after a single simulation.

It is intentionally modelled for a paper-trade loop:
- listens for candidate events
- analyses the candidate
- simulates a signed transaction
- records the outcome
- stays running for the next event

Live broadcasting remains disabled unless the configuration explicitly allows it.
