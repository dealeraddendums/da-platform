// The dealer Dashboard's stat cards, as one read — shared by the Dashboard page
// and Steven's get_inventory_summary / get_print_activity tools so the numbers a
// dealer sees on screen and the numbers Steven quotes can never disagree.
// (Moved verbatim from app/(dashboard)/dashboard/page.tsx DealerDashboardView;
// see the comment block there for why prints are the dealer_vehicles ∪
// print_history union.)

import type { createAdminSupabaseClient } from "@/lib/db";
import { printedVehicleUnionCount } from "@/lib/print-counts";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface DealerCardStats {
  totalVehicles: number;
  addedToday: number;
  printed30: number;
  printed365: number;
  /** Active vehicles with ANY document printed (Coverage numerator). */
  printedActive: number;
  queued: number;
  coveragePct: number;
}

export async function getDealerCardStats(admin: Admin, dealerId: string): Promise<DealerCardStats> {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const iso30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const iso365 = new Date(now.getTime() - 365 * 86_400_000).toISOString();
  const [
    { count: totalVehiclesCount },
    { count: addedTodayCount },
    printed30Count,
    printed365Count,
    { count: printedActiveCount },
    { count: queuedCount },
  ] = await Promise.all([
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active"),
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .gte("date_added", startOfToday.toISOString()),
    printedVehicleUnionCount(admin, { dealerId, since: iso30 }),
    printedVehicleUnionCount(admin, { dealerId, since: iso365 }),
    // Coverage — big number AND % numerator: active vehicles with ANY document
    // printed (Addendum, Info Sheet or Buyer's Guide — used vehicles are
    // often only ever given the latter two), legacy ETL-printed + platform-
    // printed uniformly. Same rule as the inventory Printed filter.
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .or("print_status.eq.1,print_info.eq.1,print_guide.eq.1"),
    // Mobile print queue (dealer_vehicles.print_queue, IOS-APP-SPEC §8.1)
    admin.from("dealer_vehicles").select("*", { count: "exact", head: true })
      .eq("dealer_id", dealerId).eq("status", "active")
      .eq("print_queue", 1),
  ]);

  const totalVehicles = totalVehiclesCount ?? 0;
  const printedActive = printedActiveCount ?? 0;
  return {
    totalVehicles,
    addedToday: addedTodayCount ?? 0,
    printed30: printed30Count ?? 0,
    printed365: printed365Count ?? 0,
    printedActive,
    queued: queuedCount ?? 0,
    coveragePct: totalVehicles > 0 ? Math.round((printedActive / totalVehicles) * 100) : 0,
  };
}
