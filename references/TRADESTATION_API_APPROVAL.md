# Aprobación de la Web API de TradeStation

Fuente: comunicación de TradeStation aportada por el usuario durante el onboarding. Fecha de recepción del correo no indicada. Este texto no contiene la API key, el secreto ni tokens.

## Texto recibido

> Congratulations! Your Web API key has been approved.
>
> T 954.652.7000 | 800.556.2022 TradeStation.com
>
> To get started, review our latest API documentation. Post your questions in the WebAPI Developer Support Forum. (If you haven’t signed up for our forums, you can do so here.)
>
> Your first step will be to get authenticated. A video guide to the authentication process is provided at the link below. Additional documentation of the authentication process is available at the second link, below.
>
> TradeStation API Authentication Explained
>
> Authentication Overview
>
> This API key is an Auth0 key (prior keys were OAuth2 keys). This API key can be used to access both Version 2 (v2) and Version 3 (v3) API endpoints. However, authentication and access token generation must be accomplished using v3 authentication endpoints (link above).
>
> This API key (also known as a client_id) and secret should be handled and stored securely as they act like a username and password. All refresh tokens that you create must be securely stored also.
>
> For professional market data subscribers, Refresh Tokens may be configured by default to expire. There is a 24-hour absolute lifetime imposed when using expiring Refresh Tokens, thereby requiring users to re-authenticate manually every 24 hours. It is your responsibility to ensure that you have re-authenticated manually with sufficient time within the past 24 hours so as to avoid any disruption to your trading activity. All users, regardless of configuration, must monitor their connectivity to TradeStation for any actions required.

Los enlaces del correo no estaban incluidos como URLs en el texto compartido. La interpretación y los requisitos de implementación se registran en [ONBOARDING.md](../ONBOARDING.md#autenticación-con-tradestation).
