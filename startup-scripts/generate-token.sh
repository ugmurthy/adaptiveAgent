# Tokens for testing adaptive-agent service
# via console
export JWT_ISSUER='http://adaptive-agent.local'
export JWT_AUDIENCE='adaptive-agent'
export JWT_HMAC_SECRET=asdf1234asdf1234asdf1234asdf1234
make_token() {
  USER_ID="$1" TENANT_ID="$2" bun -e '
    import { SignJWT } from "jose";
    const key = new TextEncoder().encode(process.env.JWT_HMAC_SECRET);
    console.log(
      await new SignJWT({ tenant_id: process.env.TENANT_ID })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(process.env.JWT_ISSUER)
        .setAudience(process.env.JWT_AUDIENCE)
        .setSubject(process.env.USER_ID)
        .setExpirationTime("24h")
        .sign(key)
    );
  '
}
export TKN=$(make_token Murthy tenant-1)
echo $TKN
echo
date
echo TOKEN Expires in 24 hours
# export ALICE_TOKEN=$(make_token alice tenant-1)
# export BOB_TOKEN=$(make_token bob tenant-1)
# export OTHER_TENANT_TOKEN=$(make_token alice tenant-2)
