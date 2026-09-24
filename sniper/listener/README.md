# WebSocket listener

This listener is intentionally minimal and configuration-driven.
It does not embed secrets or endpoints in source code and reads from environment variables at runtime through the config loader.

Required runtime variables:
- ROBINHOOD_WS_RPC
- ROBINHOOD_HTTP_RPC
- ROBINHOOD_FALLBACK_WS_RPC
- ROBINHOOD_FALLBACK_HTTP_RPC
- ROBINHOOD_CHAIN_ID
