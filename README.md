# Hatify

A record collection app, built by a dad for his son.

**[Open it →](https://themikemonday.github.io/hatify/)**

One self-contained HTML file. It plays your own Spotify library — your saved albums, as covers big enough to actually see — and nothing else. No podcasts, no audiobooks, no videos, no recommendations, no feed, no "for you", no social.

> **Right now this is a playback test, not the finished app.** It exists to answer one question on a real iPad: can a web page play a record itself, or does it have to hand off to the Spotify app? The answer decides how the rest gets built.

## What it needs

- **Spotify Premium.** Playback in the browser doesn't work without it.
- **Permission.** Spotify apps like this one run in development mode, which means the owner has to add each listener by name and email. Five people, maximum. If you're not on that list, login will refuse you.

## The idea

Spotify keeps getting better at telling you what you might like and worse at showing you what you already have. The covers got smaller. The credits went behind a dropdown. An AI turned up to explain the songs, and it's often wrong.

Hatify goes the other way:

- **Covers are the navigation**, at the biggest size the screen allows — a grid with no names, because you know your own records by looking at them, and a list with names for when you don't.
- **Nothing about the music is generated or guessed.** Every fact names a source you can go and check. Credits and liner notes come from databases built by people who care about them, not from a model.
- **It never recommends anything.** Finding music is the good part. The app's job is to hold what you found, not to have opinions about it.

## Your data

Everything stays in your own browser, on your own device. Nothing is uploaded anywhere. This repository holds the app and nothing else.

The Spotify client ID in the page is public by design — it uses the PKCE login flow, where that value is meant to ship in the app and is not a secret. There is no secret in here.

## On iOS

Open it in Safari, then Share → **Add to Home Screen** for an app icon. Worth knowing: iOS gives a home-screen web app its own storage, separate from Safari's. Anything you set in one won't appear in the other. That's iOS, not a bug, and nothing is deleted when it happens.
