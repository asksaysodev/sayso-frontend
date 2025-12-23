import ViewLayout from "@/components/layouts/ViewLayout";
import "./styles.css";

import { PricingComponent } from "@runonatlas/react";

export default function Subscription() {
  return (
    <ViewLayout title="Subscription">
      <PricingComponent
        successUrl={"sayso://subscription-success"}
      />
    </ViewLayout>
  )
}