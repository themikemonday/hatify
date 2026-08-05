/*
 * Hatify — Discogs credits with receipts.
 *
 * Spotify can name a record but does not identify a physical pressing. Discogs
 * often has several releases with the same artist, title and year, so this module
 * refuses to pick one unless the supplied album facts leave one clear candidate.
 * A missing answer is repairable. A confidently presented wrong credit is not.
 *
 * Discogs permits browser requests from Hatify's GitHub Pages origin. Successful
 * API responses have returned Access-Control-Allow-Origin: *, and the preflight
 * allow-list includes Authorization. Discogs has not consistently exposed its
 * quota headers to browser JavaScript, though, so the module reads them when it
 * can and still spaces every request and backs off on 429 when it cannot.
 */
(function () {
	'use strict';

	const API_ORIGIN = 'https://api.discogs.com';
	const WEB_ORIGIN = 'https://www.discogs.com';
	const TOKEN_KEY = 'hatify.discogs-token';
	const DATABASE = 'hatify.discogs';
	const STORE = 'hatify.discogs.credits';
	const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
	const MIN_REQUEST_GAP_MS = 1100;
	const MAX_RATE_LIMIT_RETRIES = 4;
	const MAX_CANDIDATES = 8;

	let databasePromise = null;
	let requestQueue = Promise.resolve();
	let nextRequestAt = 0;

	function failure(code, message, details = {}) {
		const error = new Error(message);
		error.name = 'HatifyDiscogsError';
		error.code = code;
		error.state = code;
		Object.assign(error, details);
		return error;
	}

	function needsToken() {
		return failure(
			'needs_discogs_token',
			'Hatify needs a Discogs personal access token. Save one with setDiscogsToken(token) on this device first.',
			{ requiresDiscogsToken: true }
		);
	}

	function getDiscogsToken() {
		let token;
		try { token = localStorage.getItem(TOKEN_KEY); }
		catch (error) {
			throw failure(
				'token_storage_unavailable',
				'This browser would not let Hatify read the Discogs token stored on this device.',
				{ cause: error }
			);
		}
		return token && token.trim() ? token.trim() : null;
	}

	function setDiscogsToken(token) {
		if (typeof token !== 'string' || !token.trim()) {
			throw failure('invalid_discogs_token', 'setDiscogsToken(token) needs a non-empty Discogs personal access token.');
		}
		try { localStorage.setItem(TOKEN_KEY, token.trim()); }
		catch (error) {
			throw failure(
				'token_storage_unavailable',
				'This browser would not let Hatify save the Discogs token on this device.',
				{ cause: error }
			);
		}
	}

	function requestResult(request, code, message) {
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(failure(code, message, { cause: request.error }));
		});
	}

	function transactionResult(transaction, code, message) {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onabort = transaction.onerror = () => reject(failure(
				code,
				message,
				{ cause: transaction.error }
			));
		});
	}

	function openDatabase() {
		if (databasePromise) return databasePromise;
		if (!globalThis.indexedDB) {
			return Promise.reject(failure(
				'cache_unavailable',
				'This browser does not provide IndexedDB, so Hatify cannot keep Discogs lookups from costing another request.'
			));
		}

		databasePromise = new Promise((resolve, reject) => {
			let request;
			try { request = indexedDB.open(DATABASE, 1); }
			catch (error) {
				reject(failure('cache_unavailable', 'Hatify could not open its Discogs cache.', { cause: error }));
				return;
			}

			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE)) {
					request.result.createObjectStore(STORE);
				}
			};
			request.onsuccess = () => {
				const database = request.result;
				database.onversionchange = () => {
					// A second Hatify tab cannot upgrade this cache while the first keeps an
					// old connection open, so release it instead of leaving both tabs stuck.
					database.close();
					databasePromise = null;
				};
				resolve(database);
			};
			request.onerror = () => {
				databasePromise = null;
				reject(failure('cache_unavailable', 'Hatify could not open its Discogs cache.', { cause: request.error }));
			};
			request.onblocked = () => {
				databasePromise = null;
				reject(failure(
					'cache_blocked',
					'Another Hatify tab is blocking the Discogs cache. Close the other tab and try again.'
				));
			};
		});

		return databasePromise;
	}

	async function readCache(albumId) {
		const database = await openDatabase();
		let request;
		try {
			request = database.transaction(STORE, 'readonly').objectStore(STORE).get(albumId);
		} catch (error) {
			throw failure('cache_read_failed', 'Hatify could not read this record from its Discogs cache.', { cause: error });
		}
		const record = await requestResult(
			request,
			'cache_read_failed',
			'Hatify could not read this record from its Discogs cache.'
		);
		if (record === undefined) return null;
		if (!record || record.albumId !== albumId || !record.result || typeof record.cachedAt !== 'number') {
			throw failure(
				'cache_corrupt',
				'Hatify found a Discogs cache entry it cannot understand. Clear the Discogs cache and try again.',
				{ albumId }
			);
		}
		if (Date.now() - record.cachedAt > CACHE_MAX_AGE_MS) return null;
		return record.result;
	}

	async function writeCache(albumId, result) {
		const database = await openDatabase();
		let transaction, request, committed;
		try {
			transaction = database.transaction(STORE, 'readwrite');
			committed = transactionResult(
				transaction,
				'cache_write_failed',
				'Hatify got the Discogs answer but could not save it for the next lookup.'
			);
			request = transaction.objectStore(STORE).put({ albumId, cachedAt: Date.now(), result }, albumId);
		} catch (error) {
			throw failure(
				'cache_write_failed',
				'Hatify got the Discogs answer but could not save it for the next lookup.',
				{ cause: error }
			);
		}
		await requestResult(
			request,
			'cache_write_failed',
			'Hatify got the Discogs answer but could not save it for the next lookup.'
		);
		// IndexedDB can accept put() and still abort at commit time when the device
		// runs out of room. Do not call that result cached until the transaction ends.
		await committed;
	}

	async function clearDiscogsCache() {
		const database = await openDatabase();
		let transaction, request, committed;
		try {
			transaction = database.transaction(STORE, 'readwrite');
			committed = transactionResult(
				transaction,
				'cache_clear_failed',
				'Hatify could not clear its Discogs cache.'
			);
			request = transaction.objectStore(STORE).clear();
		} catch (error) {
			throw failure('cache_clear_failed', 'Hatify could not clear its Discogs cache.', { cause: error });
		}
		await requestResult(request, 'cache_clear_failed', 'Hatify could not clear its Discogs cache.');
		await committed;
	}

	const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

	function retryDelay(response, attempt) {
		const value = response.headers.get('Retry-After');
		const seconds = Number(value);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
		const date = Date.parse(value);
		if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
		// Discogs has returned 429 without exposing Retry-After to cross-origin
		// JavaScript. Doubling the quiet period is safer than immediately guessing.
		return Math.min(30000, 1000 * (2 ** attempt));
	}

	function observeQuota(response) {
		const remaining = Number(response.headers.get('X-Discogs-Ratelimit-Remaining'));
		if (Number.isFinite(remaining) && remaining <= 1) {
			// Discogs reports a per-minute allowance but no reset time. A minute of
			// quiet avoids knowingly spending a request the server has said is gone.
			nextRequestAt = Math.max(nextRequestAt, Date.now() + 60000);
		}
	}

	async function responseJSON(response, endpoint) {
		try { return await response.json(); }
		catch (error) {
			throw failure(
				'discogs_response_invalid',
				`Discogs returned an unreadable response from ${endpoint}.`,
				{ status: response.status, endpoint, cause: error }
			);
		}
	}

	async function requestNow(url, token, endpoint) {
		for (let attempt = 0; ; attempt++) {
			const quietFor = Math.max(0, nextRequestAt - Date.now());
			if (quietFor) await wait(quietFor);

			let response;
			try {
				response = await fetch(url, {
					method: 'GET',
					headers: {
						Accept: 'application/vnd.discogs.v2.discogs+json',
						Authorization: 'Discogs token=' + token
					}
				});
			} catch (error) {
				// Browsers deliberately report CORS refusal and an offline network as the
				// same TypeError. Claiming which one happened would be another guess.
				throw failure(
					'network_or_cors_failure',
					`Hatify could not reach ${endpoint}. The device may be offline, or Discogs may have stopped allowing browser requests.`,
					{ endpoint, cause: error }
				);
			}

			nextRequestAt = Math.max(nextRequestAt, Date.now() + MIN_REQUEST_GAP_MS);
			observeQuota(response);

			if (response.status === 429) {
				const retryAfter = retryDelay(response, attempt);
				if (attempt >= MAX_RATE_LIMIT_RETRIES) {
					throw failure(
						'discogs_rate_limited',
						'Discogs is still asking Hatify to slow down. Try this record again later.',
						{ endpoint, retryAfter }
					);
				}
				nextRequestAt = Math.max(nextRequestAt, Date.now() + retryAfter);
				continue;
			}

			if (response.status === 401) {
				throw failure(
					'discogs_token_rejected',
					'Discogs rejected the saved personal access token. Save a new token and try again.',
					{ requiresDiscogsToken: true, status: 401, endpoint }
				);
			}
			if (response.status === 403) {
				throw failure(
					'discogs_forbidden',
					'Discogs received the request but refused it. Check the token and Discogs account, then try again.',
					{ status: 403, endpoint }
				);
			}
			if (response.status === 404) {
				throw failure('discogs_release_missing', `Discogs says ${endpoint} no longer exists.`, {
					status: 404, endpoint
				});
			}
			if (!response.ok) {
				throw failure(
					'discogs_request_failed',
					`Discogs could not answer ${endpoint} (${response.status}).`,
					{ status: response.status, endpoint }
				);
			}

			return responseJSON(response, endpoint);
		}
	}

	function discogsRequest(path, token, endpoint) {
		const url = API_ORIGIN + path;
		// Candidate checks may begin together. Keeping one shared queue prevents eight
		// records from turning into an eight-request burst on the same household IP.
		const task = requestQueue.catch(() => {}).then(() => requestNow(url, token, endpoint));
		requestQueue = task;
		return task;
	}

	function normalize(value) {
		return String(value || '')
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/&/g, ' and ')
			.replace(/[^a-z0-9]+/g, ' ')
			.trim()
			.replace(/\s+/g, ' ');
	}

	function normalizeArtist(value) {
		const cleaned = String(value || '')
			// Discogs appends a number only to separate two database artists with the
			// same name. It is not printed artist information and must not block a match.
			.replace(/\s+\(\d+\)$/, '')
			.replace(/\s*\*$/, '');
		const normalized = normalize(cleaned);
		return normalized === 'various artists' ? 'various' : normalized;
	}

	function albumYear(album) {
		const raw = album.release_date ?? album.releaseYear ?? album.release_year ?? album.year;
		const match = String(raw || '').match(/\b(18|19|20)\d{2}\b/);
		return match ? Number(match[0]) : null;
	}

	function validateAlbum(album) {
		const valid = album
			&& typeof album.id === 'string' && album.id.trim()
			&& typeof album.name === 'string' && album.name.trim()
			&& Array.isArray(album.artists) && album.artists.length
			&& album.artists.every((artist) => typeof artist === 'string' && artist.trim())
			&& Number.isInteger(album.total_tracks) && album.total_tracks > 0;
		if (!valid) {
			throw failure(
				'invalid_album',
				'discogsCredits(album) needs a Spotify album id, name, non-empty artists array, and positive total_tracks.'
			);
		}
	}

	function trackCount(release) {
		if (!Array.isArray(release.tracklist)) return null;
		let count = 0;
		for (const entry of release.tracklist) {
			if (Array.isArray(entry?.sub_tracks) && entry.sub_tracks.length) {
				count += entry.sub_tracks.filter((track) => track && track.type_ !== 'heading' && track.type_ !== 'index').length;
			} else if (entry && entry.type_ !== 'heading' && entry.type_ !== 'index') {
				count++;
			}
		}
		return count;
	}

	function releaseScore(release, album) {
		if (!release || normalize(release.title) !== normalize(album.name)) return null;
		if (!Array.isArray(release.artists) || !release.artists.length) return null;

		const wantedArtists = [...new Set(album.artists.map(normalizeArtist))].sort();
		const foundArtists = [...new Set(release.artists.map((artist) => normalizeArtist(artist?.name)))].filter(Boolean).sort();
		const artistsExact = wantedArtists.length === foundArtists.length
			&& wantedArtists.every((artist, index) => artist === foundArtists[index]);
		if (!artistsExact) return null;

		const wantedYear = albumYear(album);
		const foundYear = Number(release.year) || albumYear({ release_date: release.released });
		const yearExact = wantedYear !== null && foundYear === wantedYear;
		const foundTracks = trackCount(release);
		const tracksExact = foundTracks !== null && foundTracks === album.total_tracks;
		if (!yearExact && !tracksExact) return null;

		return 100 + (yearExact ? 10 : 0) + (tracksExact ? 10 : 0);
	}

	function releaseURL(release) {
		if (typeof release?.uri === 'string' && /^\/release\/[^/]+/.test(release.uri)) {
			return WEB_ORIGIN + release.uri;
		}
		return WEB_ORIGIN + '/release/' + encodeURIComponent(String(release.id));
	}

	function sourced(value, sourceUrl) {
		return { value, sourceUrl };
	}

	function credit(entry, trackTitle, sourceUrl) {
		if (!entry || typeof entry.name !== 'string' || !entry.name.trim()
			|| typeof entry.role !== 'string' || !entry.role.trim()) return null;
		return {
			name: entry.name,
			role: entry.role,
			trackTitle,
			sourceUrl
		};
	}

	function formatResult(release, fetchedAt) {
		const sourceUrl = releaseURL(release);
		const credits = [];
		for (const entry of Array.isArray(release.extraartists) ? release.extraartists : []) {
			const item = credit(entry, null, sourceUrl);
			if (item) credits.push(item);
		}
		for (const track of Array.isArray(release.tracklist) ? release.tracklist : []) {
			for (const entry of Array.isArray(track?.extraartists) ? track.extraartists : []) {
				const item = credit(entry, typeof track.title === 'string' ? track.title : null, sourceUrl);
				if (item) credits.push(item);
			}
		}

		const labels = Array.isArray(release.labels) ? release.labels : [];
		const formats = (Array.isArray(release.formats) ? release.formats : []).map((format) => ({
			name: typeof format?.name === 'string' ? format.name : null,
			quantity: typeof format?.qty === 'string' ? format.qty : null,
			descriptions: Array.isArray(format?.descriptions)
				? format.descriptions.filter((description) => typeof description === 'string')
				: [],
			sourceUrl
		}));

		return {
			found: true,
			releaseUrl: sourceUrl,
			credits,
			label: labels
				.filter((label) => typeof label?.name === 'string' && label.name.trim())
				.map((label) => sourced(label.name, sourceUrl)),
			catalogueNumber: labels
				.filter((label) => typeof label?.catno === 'string' && label.catno.trim())
				.map((label) => sourced(label.catno, sourceUrl)),
			country: typeof release.country === 'string' && release.country.trim()
				? sourced(release.country, sourceUrl) : null,
			released: typeof release.released === 'string' && release.released.trim()
				? sourced(release.released, sourceUrl) : null,
			formats,
			notes: typeof release.notes === 'string' && release.notes.trim()
				? sourced(release.notes, sourceUrl) : null,
			fetchedAt
		};
	}

	function noMatch(fetchedAt) {
		return {
			found: false,
			releaseUrl: null,
			credits: [],
			label: [],
			catalogueNumber: [],
			country: null,
			released: null,
			formats: [],
			notes: null,
			fetchedAt
		};
	}

	async function searchReleases(album, token, includeYear) {
		const query = new URLSearchParams({
			type: 'release',
			artist: album.artists.join(', '),
			release_title: album.name,
			per_page: '20',
			page: '1'
		});
		const year = albumYear(album);
		if (includeYear && year !== null) query.set('year', String(year));
		const data = await discogsRequest(
			'/database/search?' + query,
			token,
			'Discogs release search'
		);
		if (!data || !Array.isArray(data.results)) {
			throw failure('discogs_response_invalid', 'Discogs returned a release search Hatify cannot understand.');
		}
		return data.results.filter((result) => result?.type === 'release' && Number.isInteger(Number(result.id)));
	}

	async function candidateRelease(summary, token) {
		try {
			return await discogsRequest(
				'/releases/' + encodeURIComponent(String(summary.id)),
				token,
				`Discogs release ${summary.id}`
			);
		} catch (error) {
			// Search indexes can briefly point at a release that was removed or merged.
			// That candidate cannot be checked, but it is not evidence about the others.
			if (error?.code === 'discogs_release_missing') return null;
			throw error;
		}
	}

	async function findRelease(album, token) {
		const hasYear = albumYear(album) !== null;
		let summaries = await searchReleases(album, token, hasYear);
		if (!summaries.length && hasYear) summaries = await searchReleases(album, token, false);
		if (!summaries.length) return null;

		// If Discogs has more plausible editions than can be checked without spending
		// a large share of the minute's quota, there is no honest basis for assuming
		// the unchecked editions are worse. Return no match instead.
		if (summaries.length > MAX_CANDIDATES) return null;

		const checked = [];
		for (const summary of summaries) {
			// Start the next detail lookup only after this one has produced a usable
			// response. Pre-queuing all of them still spent requests after an earlier
			// failure, which is the opposite of respecting a shared rate limit.
			checked.push(await candidateRelease(summary, token));
		}
		const ranked = checked
			.map((release) => ({ release, score: releaseScore(release, album) }))
			.filter((candidate) => candidate.release && candidate.score !== null)
			.sort((left, right) => right.score - left.score);
		if (!ranked.length) return null;
		if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
		return ranked[0].release;
	}

	async function discogsCredits(album) {
		validateAlbum(album);
		const token = getDiscogsToken();
		if (!token) throw needsToken();

		const albumId = album.id.trim();
		const cached = await readCache(albumId);
		if (cached) return cached;

		const fetchedAt = new Date().toISOString();
		const release = await findRelease(album, token);
		const result = release ? formatResult(release, fetchedAt) : noMatch(fetchedAt);
		await writeCache(albumId, result);
		return result;
	}

	globalThis.discogsCredits = discogsCredits;
	globalThis.setDiscogsToken = setDiscogsToken;
	globalThis.getDiscogsToken = getDiscogsToken;
	globalThis.clearDiscogsCache = clearDiscogsCache;
})();
