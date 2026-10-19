// Broadcast-channel lifecycle for Live Activities (iOS 18+). Each print gets its own channel per
// APNs environment: push-to-start carries the channel id, iOS subscribes the new activity to it,
// and every update/end is published once to the channel instead of to each device's per-activity
// token.
//
// Why: a per-activity token only reaches the relay if the app runs after push-to-start to
// register it, and iOS doesn't guarantee that -- Low Power Mode or a force-quit app suppresses the
// background wake entirely. Confirmed live 2026-10-18: of two devices that accepted a Sam P1S
// push-to-start, one never registered despite six wake retries over an hour, and its Live
// Activity sat at 0% for the whole print. A channel-backed activity needs nothing from the app.
//
// One channel per print rather than one per printer: channels and activities have independent
// lifecycles, and a channel reused across prints would leave an old print's activity (still within
// its dismissal window) subscribed to the next print's updates. A print's channels are deleted
// when that printer's next print starts, so at most one set per printer exists at a time -- far
// under Apple's 10,000-per-environment limit.
//
// Everything here is best-effort and never throws: a channel that can't be created just means
// that environment's devices use per-activity tokens for this print, exactly as before.

// Creates one channel in each environment that has a push-to-start token. Environments whose
// creation fails are left out (and logged), so callers fall back to tokens there.
async function openPrintChannels({ apnsClients, environments, name }) {
  const channels = [];
  for (const environment of environments) {
    const client = apnsClients[environment];
    if (!client) continue;
    try {
      const channelId = await client.createChannel({ environment });
      channels.push({ environment, channelId });
      console.log(`Created ${environment} broadcast channel for printer "${name}" (channel ${channelId})`);
    } catch (error) {
      console.error(`Broadcast channel creation failed for printer "${name}" (${environment}) -- this print uses per-activity tokens there:`, error.message ?? error);
    }
  }
  return channels;
}

// Publishes one Live Activity payload to each of a print's channels.
async function broadcastToChannels({ apnsClients, channels, payload, priority = null, name, event, progress }) {
  for (const { environment, channelId } of channels) {
    const client = apnsClients[environment];
    if (!client) continue;
    try {
      const result = await client.broadcast({ channelId, environment, payload, priority });
      if (!result.ok) {
        console.error(`Activity ${event} broadcast failed (status ${result.status}) for printer "${name}" (${environment} channel ${channelId}): ${result.body}`);
      } else {
        console.log(`Activity ${event} broadcast accepted by APNs for printer "${name}" (progress=${progress ?? 'n/a'}, ${environment} channel ${channelId}, apns-unique-id ${result.apnsId ?? 'n/a'})`);
      }
    } catch (error) {
      console.error(`Activity ${event} broadcast threw for printer "${name}" (${environment} channel ${channelId}):`, error);
    }
  }
}

async function deleteChannels({ apnsClients, channels }) {
  for (const { environment, channelId } of channels) {
    const client = apnsClients[environment];
    if (!client) continue;
    try {
      await client.deleteChannel({ environment, channelId });
      console.log(`Deleted ${environment} broadcast channel ${channelId}`);
    } catch (error) {
      console.error(`Broadcast channel delete failed (${environment} channel ${channelId}):`, error.message ?? error);
    }
  }
}

// Deletes every channel APNs lists for the app that `keep` doesn't reference -- channels left
// behind when a delete failed, or when activity-tokens.json was lost. Run once at startup.
async function deleteOrphanChannels({ apnsClients, keep }) {
  const kept = new Set(keep.map(({ environment, channelId }) => `${environment}:${channelId}`));
  for (const [environment, client] of Object.entries(apnsClients)) {
    let listed;
    try {
      listed = await client.listChannels({ environment });
    } catch (error) {
      console.error(`Broadcast channel listing failed (${environment}) -- skipping orphan cleanup there:`, error.message ?? error);
      continue;
    }
    const orphans = listed
      .filter((channelId) => !kept.has(`${environment}:${channelId}`))
      .map((channelId) => ({ environment, channelId }));
    if (orphans.length > 0) {
      console.log(`Deleting ${orphans.length} orphaned ${environment} broadcast channel(s)`);
      await deleteChannels({ apnsClients, channels: orphans });
    }
  }
}

module.exports = { openPrintChannels, broadcastToChannels, deleteChannels, deleteOrphanChannels };
