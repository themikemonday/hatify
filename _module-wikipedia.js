/*
 * Hatify — Wikipedia album notes with receipts.
 *
 * Wikipedia has pages about songs, people and other things with the same names as
 * records. Search is only a lead, not an answer: this module accepts a page only
 * when its title, album category and opening text all agree with the Spotify
 * record. If that proof is missing, Hatify says it found no confident article.
 */
(function () {
	'use strict';

	const API = 'https://en.wikipedia.org/w/api.php';
	const DATABASE = 'hatify.wikipedia';
	const STORE = 'hatify.wikipedia.albums';
	const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
	const MIN_REQUEST_GAP_MS = 250;
	const MAX_CANDIDATES = 6;

	let databasePromise = null;
	let requestQueue = Promise.resolve();
	let nextRequestAt = 0;

	function failure(code, message, details = {}) {
		const error = new Error(message);
		error.name = 'HatifyWikipediaError';
		error.code = code;
		error.state = code;
		Object.assign(error, details);
		return error;
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
				'This browser does not provide IndexedDB, so Hatify cannot keep Wikipedia notes on this device.'
			));
		}

		databasePromise = new Promise((resolve, reject) => {
			let request;
			try { request = indexedDB.open(DATABASE, 1); }
			catch (error) {
				reject(failure('cache_unavailable', 'Hatify could not open its Wikipedia cache.', { cause: error }));
				return;
			}

			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
			};
			request.onsuccess = () => {
				const database = request.result;
				database.onversionchange = () => {
					// A second Hatify tab cannot finish an upgrade while this connection is
					// open. Closing here lets the newer tab proceed instead of both hanging.
					database.close();
					databasePromise = null;
				};
				resolve(database);
			};
			request.onerror = () => {
				databasePromise = null;
				reject(failure('cache_unavailable', 'Hatify could not open its Wikipedia cache.', { cause: request.error }));
			};
			request.onblocked = () => {
				databasePromise = null;
				reject(failure(
					'cache_blocked',
					'Another Hatify tab is blocking the Wikipedia cache. Close the other tab and try again.'
				));
			};
		});

		return databasePromise;
	}

	async function readCache(albumId) {
		const database = await openDatabase();
		let request;
		try { request = database.transaction(STORE, 'readonly').objectStore(STORE).get(albumId); }
		catch (error) {
			throw failure('cache_read_failed', 'Hatify could not read this record from its Wikipedia cache.', { cause: error });
		}
		const record = await requestResult(
			request,
			'cache_read_failed',
			'Hatify could not read this record from its Wikipedia cache.'
		);
		if (record === undefined) return null;
		if (!record || record.albumId !== albumId || !record.result || typeof record.cachedAt !== 'number') {
			throw failure(
				'cache_corrupt',
				'Hatify found a Wikipedia cache entry it cannot understand. Clear the Wikipedia cache and try again.',
				{ albumId }
			);
		}
		return Date.now() - record.cachedAt <= CACHE_MAX_AGE_MS ? record.result : null;
	}

	async function writeCache(albumId, result) {
		const database = await openDatabase();
		let transaction, committed, request;
		try {
			transaction = database.transaction(STORE, 'readwrite');
			committed = transactionResult(
				transaction,
				'cache_write_failed',
				'Hatify found the Wikipedia page but could not save it for the next lookup.'
			);
			request = transaction.objectStore(STORE).put({ albumId, cachedAt: Date.now(), result }, albumId);
		} catch (error) {
			throw failure(
				'cache_write_failed',
				'Hatify found the Wikipedia page but could not save it for the next lookup.',
				{ cause: error }
			);
		}
		await requestResult(request, 'cache_write_failed', 'Hatify could not save this Wikipedia page.');
		// IndexedDB can accept put() and still abort when the transaction commits.
		// Reporting a cache hit next time when nothing was saved is a false success.
		await committed;
	}

	async function clearWikipediaCache() {
		const database = await openDatabase();
		let transaction, committed, request;
		try {
			transaction = database.transaction(STORE, 'readwrite');
			committed = transactionResult(
				transaction,
				'cache_clear_failed',
				'Hatify could not clear its Wikipedia cache.'
			);
			request = transaction.objectStore(STORE).clear();
		} catch (error) {
			throw failure('cache_clear_failed', 'Hatify could not clear its Wikipedia cache.', { cause: error });
		}
		await requestResult(request, 'cache_clear_failed', 'Hatify could not clear its Wikipedia cache.');
		await committed;
	}

	const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

	async function requestNow(parameters, endpoint) {
		const quietFor = Math.max(0, nextRequestAt - Date.now());
		if (quietFor) await wait(quietFor);

		const query = new URLSearchParams({
			action: 'query',
			format: 'json',
			formatversion: '2',
			origin: '*',
			...parameters
		});
		let response;
		try { response = await fetch(API + '?' + query); }
		catch (error) {
			// Browsers intentionally make an offline request and a CORS refusal look
			// alike. Pretending to know which one happened would make a bad diagnosis.
			throw failure(
				'network_or_cors_failure',
				`Hatify could not reach Wikipedia for ${endpoint}. The device may be offline, or Wikipedia may have stopped allowing browser requests.`,
				{ endpoint, cause: error }
			);
		}
		nextRequestAt = Date.now() + MIN_REQUEST_GAP_MS;
		if (!response.ok) {
			throw failure(
				'wikipedia_request_failed',
				`Wikipedia could not answer ${endpoint} (${response.status}).`,
				{ endpoint, status: response.status }
			);
		}
		let data;
		try { data = await response.json(); }
		catch (error) {
			throw failure(
				'wikipedia_response_invalid',
				`Wikipedia returned an unreadable response for ${endpoint}.`,
				{ endpoint, cause: error }
			);
		}
		if (data?.error) {
			throw failure(
				'wikipedia_request_failed',
				`Wikipedia refused ${endpoint}: ${data.error.info || data.error.code || 'unknown error'}.`,
				{ endpoint, wikipediaError: data.error.code || null }
			);
		}
		return data;
	}

	function wikipediaRequest(parameters, endpoint) {
		// A quick tap from two Hatify tabs must not become a burst of anonymous
		// Wikimedia requests from one iPad. One quiet queue is enough here.
		const task = requestQueue.catch(() => {}).then(() => requestNow(parameters, endpoint));
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

	function articleTitleBase(title) {
		// "Album (album)" is Wikipedia's normal disambiguation form. Removing only
		// that suffix is safe; stripping other brackets would turn guesses into facts.
		return String(title || '').replace(/\s+\(album\)$/i, '');
	}

	function validateAlbum(album) {
		const valid = album
			&& typeof album.id === 'string' && album.id.trim()
			&& typeof album.name === 'string' && album.name.trim()
			&& Array.isArray(album.artists) && album.artists.length
			&& album.artists.every((artist) => typeof artist === 'string' && artist.trim());
		if (!valid) {
			throw failure(
				'invalid_album',
				'wikipediaAlbum(album) needs a Spotify album id, name and non-empty artists array.'
			);
		}
	}

	async function searchCandidates(album) {
		const data = await wikipediaRequest({
			list: 'search',
			srsearch: `intitle:${album.name} ${album.artists.join(' ')}`,
			srnamespace: '0',
			srlimit: String(MAX_CANDIDATES)
		}, 'Wikipedia article search');
		const results = data?.query?.search;
		if (!Array.isArray(results)) {
			throw failure('wikipedia_response_invalid', 'Wikipedia returned a search Hatify cannot understand.');
		}
		const wanted = normalize(album.name);
		return results.filter((result) => result && Number.isInteger(result.pageid)
			&& normalize(articleTitleBase(result.title)) === wanted);
	}

	async function readCandidate(pageid) {
		const data = await wikipediaRequest({
			pageids: String(pageid),
			prop: 'extracts|pageimages|info|categories',
			exintro: '1',
			explaintext: '1',
			inprop: 'url',
			piprop: 'thumbnail',
			pithumbsize: '640',
			cllimit: 'max',
			redirects: '1'
		}, `Wikipedia article ${pageid}`);
		const page = data?.query?.pages?.[0];
		if (!page || page.missing || typeof page.title !== 'string' || typeof page.fullurl !== 'string') return null;
		return page;
	}

	function candidateScore(page, album) {
		if (normalize(articleTitleBase(page.title)) !== normalize(album.name)) return null;
		const categories = Array.isArray(page.categories) ? page.categories : [];
		const categoryText = categories.map((category) => String(category?.title || '')).join(' ');
		const isAlbum = /\balbums?\b/i.test(categoryText);
		const extract = typeof page.extract === 'string' ? page.extract : '';
		const hasArtist = album.artists.some((artist) => normalize(extract).includes(normalize(artist)));
		if (!isAlbum || !hasArtist) return null;
		return 100 + (/\s+\(album\)$/i.test(page.title) ? 10 : 0)
			+ album.artists.filter((artist) => normalize(extract).includes(normalize(artist))).length;
	}

	function sourced(value, sourceUrl) {
		return value === null || value === undefined || value === '' ? null : { value, sourceUrl };
	}

	function noMatch(fetchedAt) {
		return {
			found: false,
			articleUrl: null,
			title: null,
			description: null,
			extract: null,
			thumbnail: null,
			fetchedAt
		};
	}

	function articleResult(page, fetchedAt) {
		const sourceUrl = page.fullurl;
		return {
			found: true,
			articleUrl: sourceUrl,
			title: sourced(page.title, sourceUrl),
			description: sourced(page.description, sourceUrl),
			extract: sourced(page.extract, sourceUrl),
			thumbnail: sourced(page.thumbnail?.source, sourceUrl),
			fetchedAt
		};
	}

	async function wikipediaAlbum(album) {
		validateAlbum(album);
		const albumId = album.id.trim();
		const cached = await readCache(albumId);
		if (cached) return cached;

		const fetchedAt = new Date().toISOString();
		const summaries = await searchCandidates(album);
		if (!summaries.length) {
			const result = noMatch(fetchedAt);
			await writeCache(albumId, result);
			return result;
		}

		const ranked = [];
		for (const summary of summaries) {
			const page = await readCandidate(summary.pageid);
			const score = candidateScore(page, album);
			if (score !== null) ranked.push({ page, score });
		}
		ranked.sort((left, right) => right.score - left.score);
		// This is the deliberate fork: equal proof means no proof of which article
		// Harry meant. Returning nothing is louder, and safer, than a plausible lie.
		const result = !ranked.length || (ranked[1] && ranked[0].score === ranked[1].score)
			? noMatch(fetchedAt)
			: articleResult(ranked[0].page, fetchedAt);
		await writeCache(albumId, result);
		return result;
	}

	globalThis.wikipediaAlbum = wikipediaAlbum;
	globalThis.clearWikipediaCache = clearWikipediaCache;
})();
