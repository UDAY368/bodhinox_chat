# Appointments and meetings

## Appointments and booking pages

The **Appointments** page (sidebar) books consultations, confirms them on WhatsApp and follows up after the visit.

1. **Set up (admins).** Add **Locations** (each with its own time zone), **Services** (duration, buffer, capacity, price, in person or online with a meeting link, and the days it can be booked: the *Offline free consultation: Monday only* preset allows Mondays only, judged on the location's local date), and **Staff & hours** (weekly hours per practitioner and location). A service at a location is either a shared calendar or offered by named practitioners, not both. Add **Holidays & exceptions** for closed days or changed hours.
2. **Booking page.** Under **Booking pages**, choose a slug, the services, optionally a location and the WhatsApp number, and share the link `/book/<slug>`. Visitors choose a service, place, practitioner (or any available), a date and a time (always shown in the location's time zone), optionally their name, city and state, and get a code. The slot is held for 15 minutes; it becomes a booking when they send `BOOK <code>` to your WhatsApp number from their own phone. The page never asks for a phone number.
3. **Customer link.** Confirmed customers receive a link to their booking. It shows the service, practitioner, place, time and price (and the meeting link from 24 hours before an online visit), and lets them cancel or move the booking until the cutoff set in settings (default 2 hours before). It never shows their name or phone, so it is safe if forwarded.
4. **Reminders.** Sent 24 hours and 2 hours before the visit when the toggles are on; a reminder that would be late is skipped, never sent late, and a booking that was moved or cancelled never gets the old reminder. Outside the 24-hour WhatsApp window you need approved **Utility** templates in settings.
5. **After the visit.** Mark **Completed** or **No-show** (recorded by staff). A no-show creates a follow-up task; a completed visit can send a feedback message and creates a rebooking task when the service has those settings. Do not record clinical details in the staff note.
6. **Flows and automations.** The **Book appointment** flow step lets customers book inside a WhatsApp conversation; the triggers *Appointment booked / cancelled / rescheduled / completed / no-show* start automations.

**Paid consultations**: in Appointments → Services, set a price and turn on **Require advance payment** (needs Razorpay connected under Payments and a plan with the storefront). Customers booking online see "Pay in advance"; after they send the WhatsApp code they receive a payment link, and the booking is confirmed automatically once the payment is verified. Bookings you make yourself are confirmed straight away and are not charged online.

## Online meetings and courier shipping

- **Settings → Meetings & shipping** is where admins connect Zoom (online appointments) and Shiprocket (courier shipping). Both are optional and off until connected.
- Creating and cancelling courier shipments needs the **Create and cancel courier shipments** permission; connecting Zoom needs **Connect Zoom for online meetings**. Both can be taken away from admins in Settings → Team members → Feature permissions.

### Online meetings (Zoom)

- Settings → Meetings & shipping → Zoom meetings → **Connect Zoom**. A Zoom account admin approves the app once. Meetings for confirmed online appointments are then created automatically. The host is the practitioner's Zoom host email (Appointments → Practitioners), or otherwise the admin who connected Zoom.
- If an appointment shows that its meeting needs attention, open its task. **Create again** makes a new Zoom meeting; **Use supplied link** goes back to the service's own meeting link.
- **Disconnect** stops Bodhinox from creating, moving or removing meetings. Links already sent keep working.
- After Zoom is connected (Settings → Meetings & shipping), set a **Zoom host email** on each practitioner who hosts from their own Zoom user in your Zoom account; leave it blank to host from the account that connected Zoom.
- The appointment sheet shows the meeting state and, after the meeting, what Zoom recorded about joins. This is evidence only: mark the appointment completed or no-show yourself. A **Record outcome** task reminds the practitioner after Zoom reports the meeting ended.
- If the sheet says **Needs attention**, choose **Create again** (a new Zoom meeting and link) or **Use supplied link** (go back to the link you entered before Zoom).
