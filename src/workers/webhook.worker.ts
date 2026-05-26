// import { tryCatch, Worker } from "bullmq";
// import { redisConnection } from "../config/redis.config.js";

// import axios from "axios";
// import { supabase } from "../config/db.config.js";

// new Worker(
//   "webhookQueue",
//   async (job) => {
//     const { eventId } = job.data;

//     const { data: event } = await supabase
//       .from("webhook_events")
//       .select("*, webhooks(*)")
//       .eq("id", eventId)
//       .single();

//       if (!event) return;
//        const webhook = event.webhooks;

//       try{
//                 await supabase
//         .from("webhook_events")
//         .update({
//           status: "processed",
//           processed_at: new Date().toISOString(),
//         })
//         .eq("id", eventId);

//         await supabase
//         .from("webhooks")
//         .update({
//           last_triggered_at: new Date().toISOString(),
//         })
//         .eq("id", webhook.id);

//       } catch(error){
//         await supabase
//         .from("webhook_events")
//         .update({ status: "failed" })
//         .eq("id", eventId);

//       throw error; // important for retry
//       }



//   },
//   {
//     connection: redisConnection,
//     concurrency: 5,
//   }
// )


// import axios from "axios";
// import { supabase } from "../config/db.config.js";

// export async function processPendingEvents() {
//   try {
//     const { data: events, error } = await supabase
//       .from("webhook_events")
//       .select("*, webhooks(*)")
//       .eq("status", "pending")
//       .limit(5);

//     if (error || !events || events.length === 0) {
//       return;
//     }

//     for (const event of events) {
//       try {
//         const webhook = event.webhooks;

//         // 🔥 For now we skip external API call
//         // Later you can enable axios call here

//         await supabase
//           .from("webhook_events")
//           .update({
//             status: "processed",
//             processed_at: new Date().toISOString(),
//           })
//           .eq("id", event.id);

//         await supabase
//           .from("webhooks")
//           .update({
//             last_triggered_at: new Date().toISOString(),
//           })
//           .eq("id", webhook.id);

//       } catch (err) {
//         await supabase
//           .from("webhook_events")
//           .update({ status: "failed" })
//           .eq("id", event.id);
//       }
//     }
//   } catch (err) {
//     console.error("Worker crashed:", err);
//   }
// }