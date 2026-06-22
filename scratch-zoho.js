import dotenv from "dotenv";
dotenv.config();

async function test() {
  const env = process.env;
  
  // Refresh token flow
  console.log("Refreshing Zoho access token...");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN
  });

  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Failed to refresh Zoho token:", res.status, errText);
    return;
  }

  const data = await res.json();
  const accessToken = data.access_token;
  console.log("Access token retrieved: SUCCESS");

  // Let's try to update expect_finish date-time
  const ticketId = "483929000060312222";
  
  // Test formatting:
  const testVal = new Date("2026-06-19T18:13:00+07:00").toISOString();
  console.log(`Attempting to update expect_finish to: ${testVal}...`);

  const updateResponse = await fetch(`https://desk.zoho.com/api/v1/tickets/${ticketId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Zoho-oauthtoken ${accessToken}`,
      "orgId": env.ZOHO_ORG_ID,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      cf: {
        cf_expect_finish_by_dev: testVal
      }
    })
  });

  console.log("Update Response Status:", updateResponse.status);
  const resData = await updateResponse.json();
  console.log("Update Response Data:", JSON.stringify(resData, null, 2));
}

test();
