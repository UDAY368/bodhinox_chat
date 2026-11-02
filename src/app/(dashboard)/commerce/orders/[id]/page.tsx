"use client";

import { useParams } from "next/navigation";

import { OrderDetailView } from "@/components/commerce/orders/order-detail";

export default function OrderPage() {
  const params = useParams<{ id: string }>();
  return params.id ? <OrderDetailView id={params.id} /> : null;
}
