import { EventsAttention } from "@/components/commerce/events-attention";
import { OrdersList } from "@/components/commerce/orders/orders-list";
import { ShipmentExceptions } from "@/components/commerce/orders/shipment-exceptions";

export default function OrdersPage() {
  return (
    <>
      <EventsAttention />
      <ShipmentExceptions />
      <OrdersList />
    </>
  );
}
