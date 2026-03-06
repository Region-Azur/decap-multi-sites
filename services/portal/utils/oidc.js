function normalizeEmail(value) {
  if (!value) {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : "";
}

async function fetchUserInfo(issuer, accessToken, userInfoUrlOverride) {
  try {
    const normalizedIssuer = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
    const normalizedOverride = userInfoUrlOverride.replace(/\/$/, "");
    const userInfoUrl = normalizedOverride || `${normalizedIssuer}/oauth/userinfo`;
    const userInfoRes = await fetch(userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (userInfoRes.ok) {
      const userInfo = await userInfoRes.json();
      console.log("DEBUG: User info fetched:", JSON.stringify(userInfo, null, 2));
      return userInfo;
    } else {
      console.error("DEBUG: Failed to fetch user info:", userInfoRes.status, await userInfoRes.text())
    }
  } catch (err) {
    console.error("DEBUG: Error fetching user info:", err);
  }
  return null;
}

function parseJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  } catch (e) {
    return null;
  }
}

module.exports = {
  normalizeEmail,
  fetchUserInfo,
  parseJwt,
};

