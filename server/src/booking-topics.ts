// Varausaiheet (incidents.ts TOPIC_RULES): eivät ole vikoja, joten niitä ei seurata poikkeamina, toistuvina vikoina
// eikä portaan historiassa. Erillään incidents.ts:stä, jotta kevyet moduulit (esim. integraation muunnos) voivat käyttää niitä.
export const BOOKING_TOPICS: readonly string[] = ["parking", "sauna_booking", "laundry_booking", "booking"];
export const isBookingTopic = (topic: string | null | undefined) => Boolean(topic && BOOKING_TOPICS.includes(topic));
