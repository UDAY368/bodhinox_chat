"use client";

import { useParams } from "next/navigation";

import { ProductEditor } from "@/components/commerce/catalogue-admin/product-editor";

export default function CatalogueProductPage() {
  const params = useParams<{ id: string }>();
  return params.id ? <ProductEditor id={params.id} /> : null;
}
