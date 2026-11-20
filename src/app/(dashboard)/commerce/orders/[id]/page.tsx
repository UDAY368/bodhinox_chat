"use client";

import { useParams } from "next/navigation";

import { OrderView } from "@/components/commerce/orders/order-view";

export default function OrderPage() {
  const params = useParams<{ id: string }>();
  return params.id ? <OrderView key={params.id} orderId={params.id} variant="page" /> : null;
}
