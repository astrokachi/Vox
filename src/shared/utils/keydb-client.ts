import { createClient, RedisClientType } from "redis";
import { getKeydbUrl } from "../lib/keydb-url.js";

export const keydbClient: RedisClientType = createClient({
  url: getKeydbUrl(),
});

keydbClient.on("error", (err) => {
  console.error("KeyDB error: ", err);
});

(async () => {
  try {
    await keydbClient.connect();
    console.log("Connected to KeyDB.");
  } catch (error) {
    console.error("Failed to connect to KeyDB: ", error);
  }
})();
