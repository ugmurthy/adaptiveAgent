# Authentication Flow with JWT - State Diagram

This diagram depicts a typical JWT-based authentication flow involving:
- **Client**: The application requesting access
- **Authorizer** (Authorization Server): Third-party service that authenticates and issues JWTs
- **Resource Server**: The protected API/service being accessed

```mermaid
stateDiagram-v2
    [*] --> Client: Initial State
    
    state Client {
        [*] --> Idle
        
        Idle --> RequestAuth: User action / Need access
        UnauthorizedToken --> RequestAuth: Access denied
        InvalidToken --> RequestAuth: Token expired/invalid
        
        state RequestAuth {
            [*] --> CollectCredentials
            CollectCredentials --> SubmitCredentials
            SubmitCredentials --> AuthInProgress
        }
        
        AuthInProgress --> Authenticated: Credentials verified
        AuthInProgress --> AuthFailed: Credentials invalid
        
        Authenticated --> HasAccessToken: Received JWT token
        HasAccessToken --> AccessingResource: Presenting token to server
        
        AccessingResource --> ResourceAccessed: Token valid
        AccessingResource --> UnauthorizedToken: Token rejected
        AccessingResource --> RefreshingToken: Token expiring soon
        
        RefreshingToken --> HasAccessToken: New token received
        RefreshingToken --> InvalidToken: Refresh failed
        
        ResourceAccessed --> HasAccessToken: Continue session
        ResourceAccessed --> Idle: User done / Logout
        AuthFailed --> Idle: Try again later
        InvalidToken --> Idle: Token refresh exhausted
    }
    
    state Authorizer {
        [*] --> WaitingRequest
        
        WaitingRequest --> VerifyingCredentials: Login request received
        VerifyingCredentials --> GeneratingJWT: Credentials valid
        VerifyingCredentials --> Rejected: Credentials invalid
        
        GeneratingJWT --> IssuingToken: JWT signed
        IssuingToken --> ReturnedToken: Token sent to client
        ReturnedToken --> WaitingRequest
        
        RefreshRequested --> ValidatingRefreshToken: Refresh request received
        ValidatingRefreshToken --> IssuingNewToken: Refresh token valid
        ValidatingRefreshToken --> Revoked: Refresh token invalid/expired
        
        Revoked --> WaitingRequest
        IssuingNewToken --> ReturnedToken
        
        ValidateRequested --> VerifyingJWTSignature: Token validation request
        VerifyingJWTSignature --> CheckingClaims: Signature valid
        CheckingClaims --> ClaimValidation: Expiry, audience checked
        ClaimValidation --> TokenValid: All checks pass
        ClaimValidation --> TokenInvalid: Validation failed
        ClaimValidation --> WaitingRequest
        TokenValid --> WaitingRequest
        TokenInvalid --> WaitingRequest
    }
    
    state ResourceServer {
        [*] --> ProtectedEndpoint
        
        ProtectedEndpoint --> TokenReceived: Request with Bearer token
        TokenReceived --> ValidatingToken: Send to Authorizer
        
        ValidatingToken --> Authorized: Token valid
        ValidatingToken --> AccessDenied: Token invalid
        
        Authorized --> ProcessingRequest: Grant access
        ProcessingRequest --> ResponseSent: Complete operation
        ResponseSent --> ProtectedEndpoint
        
        AccessDenied --> ErrorResponse: Return 401/403
        ErrorResponse --> ProtectedEndpoint
    }
    
    %% Cross-component transitions
    Client.RequestAuth --> Authorizer.VerifyingCredentials: POST credentials
    Authorizer.ReturnedToken --> Client.Authenticated: Return JWT
    Authorizer.Rejected --> Client.AuthFailed: Error response
    
    Client.HasAccessToken --> ResourceServer.TokenReceived: GET/POST with Authorization header
    ResourceServer.ValidatingToken --> Authorizer.ValidateRequested: Token verification call
    Authorizer.TokenValid --> ResourceServer.Authorized: Verification OK
    Authorizer.TokenInvalid --> ResourceServer.AccessDenied: Verification failed
    
    Client.RefreshingToken --> Authorizer.RefreshRequested: Refresh token request
    Authorizer.IssuingNewToken --> Client.HasAccessToken: New JWT issued
    
    Client.Idle --> [*]: Session complete
```

## Legend

| Component | Description |
|-----------|-------------|
| **Client** | Application making authenticated requests |
| **Authorizer** | Third-party Authorization Server (OAuth2/OIDC provider) |
| **Resource Server** | Protected API endpoint requiring authentication |

## Key JWT States Explained

1. **Idle → RequestAuth**: User initiates login or app needs access
2. **VerifyingCredentials**: Authorizer validates username/password or other credentials
3. **GeneratingJWT**: Authorizer creates signed JWT with claims (subject, issuer, expiry, scope)
4. **HasAccessToken**: Client stores JWT (typically in secure storage/localStorage)
5. **AccessingResource**: Client includes `Authorization: Bearer <JWT>` header
6. **ValidatingToken**: Resource server verifies JWT signature and claims
7. **RefreshingToken**: Client uses refresh token before access token expires
8. **TokenInvalid/Revoked**: Token expired, tampered, or revoked

## Security Notes

- **Access tokens** are short-lived (minutes to hours)
- **Refresh tokens** allow obtaining new access tokens without re-authentication
- Always verify: **signature**, **issuer (iss)**, **audience (aud)**, **expiration (exp)**, **not-before (nbf)**
- Use HTTPS for all token transmissions
