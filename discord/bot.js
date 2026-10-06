import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  MessageFlags,
} from "discord.js";
import { createHash } from "node:crypto";
import { signBody } from "../src/signature.js";
import { pathToFileURL } from "node:url";
export function interactionUUID(id) {
  const b = createHash("sha256")
    .update("discord:" + id)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const commands = [
  new SlashCommandBuilder()
    .setName("challenge")
    .setDescription(
      "Challenge a verified driver in a scheduled external sim race.",
    )
    .addUserOption((o) =>
      o
        .setName("opponent")
        .setDescription("The player who must accept")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("entry")
        .setDescription("Entry per player, e.g. 10.00")
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName("currency")
        .setDescription("Separate coin balance")
        .setRequired(true)
        .addChoices(
          { name: "Gold Coins", value: "GC" },
          { name: "Sweeps Coins", value: "SC" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("event")
        .setDescription("Scheduled event ID from the web lobby")
        .setRequired(true),
    ),
].map((c) => c.toJSON());
export async function brokerPost(
  path,
  body,
  env = process.env,
  fetcher = fetch,
) {
  const raw = Buffer.from(JSON.stringify(body)),
    timestamp = String(Math.floor(Date.now() / 1000)),
    secret = Buffer.from(env.DISCORD_BROKER_SECRET_BASE64 ?? "", "base64");
  if (secret.length < 32) throw new Error("broker_configuration_required");
  const origin = new URL(env.BACKEND_API_BASE_URL);
  if (origin.protocol !== "https:") throw new Error("https_required");
  const r = await fetcher(new URL(path, origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telemetry-Key-Id": env.DISCORD_BROKER_KEY_ID,
      "X-Telemetry-Timestamp": timestamp,
      "X-Telemetry-Signature": signBody(
        secret,
        env.DISCORD_BROKER_KEY_ID,
        timestamp,
        raw,
        path,
      ),
    },
    body: raw,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "challenge_rejected");
  return data;
}
export async function handleInteraction(
  i,
  env = process.env,
  post = brokerPost,
) {
  if (i.isButton()) {
    const m = /^accept_([a-f0-9-]{36})_(\d{17,20})$/.exec(i.customId);
    if (!m) return;
    if (i.user.id !== m[2])
      return i.reply({
        content: "Only the invited opponent can accept this challenge.",
        flags: MessageFlags.Ephemeral,
      });
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await post(
        "/api/v1/challenges/accept",
        { actor_discord_id: i.user.id, offer_id: m[1] },
        env,
      );
      await i.editReply(
        `Accepted. Both entries are held in escrow. Challenge ${result.challenge_id}.`,
      );
    } catch {
      await i.editReply(
        "Acceptance was not confirmed. Check the web dashboard before retrying.",
      );
    }
    return;
  }
  if (!i.isChatInputCommand() || i.commandName !== "challenge") return;
  const opponent = i.options.getUser("opponent", true),
    entry = i.options.getString("entry", true),
    event = i.options.getString("event", true),
    currency = i.options.getString("currency", true);
  if (
    opponent.bot ||
    opponent.id === i.user.id ||
    !/^\d{1,4}(\.\d{1,2})?$/.test(entry) ||
    !Number.isFinite(Number(entry)) ||
    Number(entry) <= 0 ||
    !/^\w{8}-(\w{4}-){3}\w{12}$/.test(event)
  )
    return i.reply({
      content:
        "Choose a different player, a positive entry of at most 1,000, and a scheduled event ID.",
      flags: MessageFlags.Ephemeral,
    });
  await i.deferReply();
  try {
    const result = await post(
      "/api/v1/challenges/initiate",
      {
        actor_discord_id: i.user.id,
        opponent_discord_id: opponent.id,
        request_id: interactionUUID(i.id),
        event_id: event,
        token_type: currency,
        entry_fee: entry,
      },
      env,
    );
    const url = new URL("/#races", env.APP_ORIGIN);
    const embed = new EmbedBuilder()
      .setColor(currency === "SC" ? 0x22d3ee : 0xf3bd48)
      .setTitle("External sim race · P2P challenge")
      .setDescription(
        `<@${i.user.id}> challenges <@${opponent.id}>. Both players must have verified simulator accounts. Entries are locked only after acceptance.`,
      )
      .addFields(
        { name: "Entry per player", value: `${entry} ${currency}` },
        {
          name: "Terms",
          value:
            "Verified event rules apply. Winning payout is 90% of both entries; 10% platform fee. Invalid results, ties, confirmed disconnects, and expired validation receive a full zero-fee refund.",
        },
        { name: "Event", value: result.event_title || event },
        {
          name: "Track",
          value: result.track_name || "See registered event terms",
        },
      )
      .setFooter({ text: `Challenge ${result.offer_id}` });
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`accept_${result.offer_id}_${opponent.id}`)
        .setStyle(ButtonStyle.Success)
        .setLabel("Accept Challenge 🏎️"),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(url.href)
        .setLabel("Open race dashboard"),
    );
    await i.editReply({ embeds: [embed], components: [buttons] });
  } catch {
    await i.editReply(
      "The challenge was not confirmed. Both players must connect Discord and their simulator account. Check that the event is open and retry the same interaction.",
    );
  }
}
export async function startBot(env = process.env) {
  if (
    !env.DISCORD_BOT_TOKEN ||
    !env.DISCORD_CLIENT_ID ||
    !env.DISCORD_BROKER_SECRET_BASE64 ||
    !env.APP_ORIGIN
  )
    throw new Error("discord_configuration_required");
  if (process.argv.includes("--register")) {
    await new REST({ version: "10" })
      .setToken(env.DISCORD_BOT_TOKEN)
      .put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), {
        body: commands,
      });
    return;
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on("interactionCreate", (i) =>
    handleInteraction(i, env).catch(() =>
      console.error("discord_interaction_failed"),
    ),
  );
  client.once("ready", () => console.log("discord_ready"));
  process.once("SIGTERM", () => client.destroy());
  await client.login(env.DISCORD_BOT_TOKEN);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startBot().catch(() => {
    console.error("discord_configuration_or_connection_failed");
    process.exitCode = 1;
  });
