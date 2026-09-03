# CDK / Fortellis — Inventory Write API Inquiry

## Email to CDK / Fortellis contact

**To:** [CDK account manager / Fortellis certification contact]
**From:** allan@dealeraddendums.com
**Subject:** Fortellis ISV inquiry — inventory write API (inbound successor to PIP vehicle updates)?

Hi [Name],

I'm the owner of DealerAddendums (Fortellis developer account under
DealerAddendums LLC). Our app is currently in certification consuming **CDK
Drive Get Merchandisable Vehicles v2** as our replacement for the retiring
PIP inventory extract — that migration is on track on our side.

I have a roadmap question about the **write direction**.

DealerAddendums manages dealer-installed products and addendum pricing for
roughly 2,000 dealerships — the accessories, protection products, doc fees,
dealer discounts, and added markups that appear on each vehicle's addendum
sticker. Today we syndicate that data outward to website providers and
merchandising platforms (HomeNet and others) via per-provider feeds.

What we'd rather do is write it **once, at the source of truth**: set those
values on the vehicle's record in CDK Drive, so they flow out through CDK's
own inventory syndication to every downstream partner automatically. The old
3PA/PIP program had inbound vehicle-update transactions that could have
served this; the Fortellis Vehicle Sales catalog we can see today
(Merchandisable Vehicles v1 / composite) is read-only.

So, specifically:

1. Is there a Fortellis API — public, private preview, or on the roadmap —
   that lets a certified ISV **update inventory vehicle records in Drive**
   (accessory/option lines, misc prices, doc fee, discount/markup fields)?
2. If yes: what's the access path (subscription, certification scope,
   timeline)? We're mid-certification now and could fold it in.
3. If no: is post-PIP inbound inventory write on the roadmap, and can we be
   a design partner? Our use case is concrete, bounded (a handful of pricing
   and option-line fields, keyed by VIN/stock), and live at scale.

Happy to get on a call with the product team if that's easier.

Thanks,
Allan Tone
DealerAddendums LLC
allan@dealeraddendums.com

---

## Fortellis Community post (API Request forum)

**Forum:** https://community.fortellis.io/community/forum/fortellis-api-request
**Title:** Inventory write API — update Merchandisable Vehicle pricing/options from an ISV app?

We're a certified ISV (addendum/dealer-installed-product management, ~2,000
rooftops) consuming **CDK Drive Get Merchandisable Vehicles v2** as our PIP
extract replacement.

Our dealers maintain dealer-installed products, doc fees, discounts, and
added markups in our platform, and we currently syndicate those to website
providers via per-provider feeds. We'd like to write them to the source of
truth instead: **update the vehicle's inventory record in CDK Drive** (option
lines / misc price fields) so CDK's own syndication carries the data to all
downstream partners.

The Vehicle Sales catalog appears read-only (Merchandisable Vehicles v1 and
composite are all GET; the only Update Vehicle POST is in the Vehicle
Service domain, which is service-customer vehicles, not inventory).

Questions:
1. Is there an existing API — or private/partner API — for writing
   inventory vehicle pricing/options to Drive?
2. If not, is an inbound inventory write planned as part of the post-PIP
   Fortellis surface? The retired 3PA/PIP program had inbound vehicle-update
   transactions; we haven't found the Fortellis equivalent.

Use case is narrow and well-bounded: set accessory/option line items and a
few misc price fields, keyed by VIN/stock number, per dealer subscription.
Happy to provide detailed requirements or join a preview program.
