import * as webhookService from "../services/webhook.service.js";
import { verifyAndParse } from "../services/webhook.service.js";

// Deliberately does NOT use responseHandler. Stripe reads the status code and
// nothing else, and wrapping the reply in this system's success envelope would be
// dressing up a machine ack as an API response.
//
// Any 2xx tells Stripe to stop retrying. So: 200 for handled, 200 for a duplicate,
// 200 for an event we do not route — and non-2xx ONLY when a retry could plausibly
// succeed (a bad signature is 400 because retrying will not fix it, but it also
// must not be acked, since acking a forged request is indistinguishable from
// accepting it).
export const handleStripeWebhook = async (req, res) => {
    const event = verifyAndParse(req.body, req.get("stripe-signature"));
    const outcome = await webhookService.processEvent(event, req.correlationId);
    res.status(200).json({ received: true, eventId: event.id, outcome });
};
