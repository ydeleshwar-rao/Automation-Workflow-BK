export type JobDetailDataBlock = {
  contact: {
    name: string;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    type: string | null;
    is_primary_contact: string | null;
  } | null;

  site: {
    name: string | null;
    website: string | null;
    abn_number: string | null;
    address: string | null;
    address_street: string | null;
    address_city: string | null;
    address_state: string | null;
    address_postcode: string | null;
    address_country: string | null;
    billing_address: string | null;
    fax_number: string | null;
  } | null;

  head_office: {
    name: string | null;
    address: string | null;
  } | null;

  job: {
    generated_job_id: string | null;
    status: string | null;
    date: string | null;
    job_address: string | null;
    job_description: string | null;
    work_done_description: string | null;
    total_invoice_amount: string | null;
    purchase_order_number: string | null;
    category: string | null;
    quote_date: string | null;
    completion_date: string | null;
  };

  engineer: {
    name: string;
    email: string | null;
    mobile: string | null;
    job_title: string | null;
    status_message: string | null;
  } | null;

  payment: {
    status: string;
    amount: string | null;
    method: string | null;
    date: string | null;
    total_invoice: string | null;
    ready_to_invoice: boolean;
    payments: unknown[];
  };

  activities: {
    start_date: unknown;
    end_date: unknown;
    scheduled: unknown;
  }[];

  jobmaterials: {
    name: string | null;
    quantity: unknown;
    price: unknown;
    total: unknown;
    displayed_amount: unknown;
    cost: unknown;
    displayed_cost: unknown;
  }[];
};