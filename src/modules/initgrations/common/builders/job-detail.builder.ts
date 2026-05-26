import { JobDetailDataBlock } from "../types/job-detail.types.js";

export class JobDetailBuilder {

  static empty(): JobDetailDataBlock {
    return {
      contact: null,
      site: null,
      head_office: null,

      job: {
        generated_job_id: null,
        status: null,
        date: null,
        job_address: null,
        job_description: null,
        work_done_description: null,
        total_invoice_amount: null,
        purchase_order_number: null,
        category: null,
        quote_date: null,
        completion_date: null
      },

      engineer: null,

      payment: {
        status: "Unpaid",
        amount: null,
        method: null,
        date: null,
        total_invoice: null,
        ready_to_invoice: false,
        payments: []
      },

      activities: [],
      jobmaterials: []
    }
  }

}