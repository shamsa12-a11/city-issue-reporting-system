/**
 * SMS provider adapters (brief §6.6: simulated SMS behind a clean adapter
 * interface, replaceable by a real integration later).
 *
 * Interface:
 *   name        'outbox' (simulated)
 *   simulated   true for the simulator
 *   send(client, { recipients, issueId, messageEn, messageSo })
 *     recipients: [{ userId, phoneNumber, language: 'so'|'en' }], already
 *     filtered by the caller (active, SMS enabled). Runs on the caller's
 *     transaction client, so a failure rolls the whole change back.
 *     -> Promise<Array<{ id, user_id }>>
 *
 * The only provider is the in-app outbox simulator: it saves one row per
 * recipient in sms_outbox (status 'simulated_sent'), in the recipient's
 * language. No message is ever sent to a phone. A real provider would send
 * here (ideally after commit, via the outbox) and keep the same interface.
 */

const outboxProvider = Object.freeze({
  name: 'outbox',
  simulated: true,
  async send(client, { recipients, issueId = null, messageEn, messageSo }) {
    if (recipients.length === 0) return [];
    const { rows } = await client.query(
      `INSERT INTO sms_outbox (user_id, issue_id, phone_number, language, message)
       SELECT r.user_id, $4::bigint, r.phone_number, r.language,
              CASE WHEN r.language = 'so' THEN $6::text ELSE $5::text END
         FROM unnest($1::bigint[], $2::text[], $3::text[]) AS r (user_id, phone_number, language)
       RETURNING id, user_id`,
      [recipients.map((r) => r.userId), recipients.map((r) => r.phoneNumber), recipients.map((r) => r.language), issueId, messageEn, messageSo]
    );
    return rows;
  },
});

let current = outboxProvider;

/** The SMS provider in use (the simulated outbox). */
const getSmsProvider = () => current;

/** Replaces the provider (tests, or a real integration at start-up). */
function setSmsProvider(provider) {
  if (!provider || typeof provider.send !== 'function' || typeof provider.name !== 'string') {
    throw new Error('An SMS provider needs a name and a send(client, message) function');
  }
  current = provider;
}

/** Restores the simulated outbox provider. */
const resetSmsProvider = () => {
  current = outboxProvider;
};

module.exports = { getSmsProvider, setSmsProvider, resetSmsProvider, outboxProvider };
