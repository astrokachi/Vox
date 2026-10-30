import { createClient, RedisClientType } from "redis";
import { getValkeyUrl } from "../lib/valkey-url.js";

export const valkeyClient: RedisClientType = createClient({
  url: getValkeyUrl(),
});

valkeyClient.on("error", (err) => {
  console.error("Valkey error: ", err);
});

(async () => {
  try {
    await valkeyClient.connect();
    console.log("Connected to Valkey.");
  } catch (error) {
    console.error("Failed to connect to Valkey: ", error);
  }
})();
