# What Harry said, and what changed

Every report Harry sends through the 💬 button, and what happened to it. This file
exists because his reports are the loop that makes the app his — and because
without it, nobody could tell what had been done and what hadn't.

Newest first.

---

## 2026-08-05

**"I'd like there to be a search feature at the top so when I hear about a new album or artist I can search for it there."**
Not built yet — next. It searches his own shelf *and* Spotify, because the reason
he gave is the important part: he hears about a record and wants to go and find
it. That is chasing something he found, not being offered something.

**"I'd also like an artist section where you can click on it and see their albums."**
Not built yet — next, alongside search.

**"I want there to be a settings button in the top corner to view the eq, and playback settings."**
Half done, and the other half is a plain no. ⚙ in the top corner now holds volume,
shuffle and repeat. **There is no EQ and there cannot be one.** Spotify plays the
sound inside its own sealed player and nothing in this app can reach it to change
it. Drawing sliders that moved nothing would have been the easy lie. Asked three
times, so it is clearly wanted — there is one route to it, and it is written up
for Harry to decide on rather than decided for him.

**"There are doubles of some albums (e.g. a love supreme) because I have the monophonic edition saved as well… show them as one album and when you click the cover… an option to play a different version."**
Done. The shelf shows one cover per record; open it and the pressings are there —
*Original · 4 / Monophonic · 4 / Deluxe Edition · 8*. Matching strips edition
wording and requires the same artist. Deliberately cautious: wrongly merging two
genuinely different records is worse than leaving a double on the shelf, so where
it is unsure it leaves both.

**"I want to be able to click on the cover to go to view the tracklist."**
Done. Tap a cover for the sleeve, label, year and tracklist with times. Tapping a
track plays the record on from there rather than firing off one track alone.
Holding a cover still peeks it big.

**"I want the album covers to also be seperated into singles and EPs."**
Done. Spotify has no EP type — an EP arrives tagged "single" with several tracks
on it — so the split is on track count, the same call a shop makes putting a
five-track 12" in the EP rack rather than the singles bin. The pills carry counts,
so "Singles · 0" reads as a fact rather than a broken screen.

**"I'd like the album covers to be bigger in the grid."**
Done, and part of this was a bug: the shelf was laying itself out four-across so
every cover was crushed into a quarter of the width. Fixed, and cover size is now
Harry's to set — Small, Medium, Big, Huge — because guessing at it twice was
enough.

**"I'd like the play, and skip buttons to be something that looks more like an analogue system."**
Done. Tape-deck keys that travel when pressed, not phone icons.

**"When it opens the tracklist it would be cool if it could source credits and any liner notes from Wikipedia."**
Being built now, from **Discogs and Wikipedia** both. Discogs carries personnel,
label, catalogue number and pressing detail; Wikipedia carries the writing. Every
line will name where it came from and link to it, so nothing has to be taken on
trust. Nothing will ever be generated or guessed — that is the whole point, and
it is his own objection to Spotify's AI, which "tells you stuff about the song.
But often, it's wrong."

---

## 2026-08-04 — from Mike, testing before Harry saw it

**The lock screen says "Spotify embedded player" instead of the record.**
Cannot be fixed, and it is worth knowing why. Spotify plays the audio inside a
frame on its own servers, and iOS takes the Now Playing information from whatever
is actually playing — which is theirs, not ours. Developers have been asking
Spotify to open a route for this since 2018. Playback itself is unaffected. The
code that would do it is left in place, commented, so it starts working the day
Spotify allows it.
