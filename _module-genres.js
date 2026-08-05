/*
 * Hatify — Spotify's artist genres, made useful without pretending they are facts.
 *
 * Spotify's saved-album response returned empty album genres in practice. The
 * useful tags live on the primary artist, so this module fetches each distinct
 * artist once and keeps Spotify's original tags beside the broad shelf family.
 * The family is Hatify's judgement; the tags are Spotify's evidence for it.
 */
(function () {
	'use strict';

	/*
	 * This is the judgement table. A family scores one point when one of its terms
	 * appears as a complete word or phrase in a Spotify tag, and three points when
	 * the whole tag exactly matches a term. Scores add across all of an artist's
	 * tags. The first family below wins a tie, so both the vocabulary and the tie
	 * break are visible here rather than hidden in sorting code.
	 *
	 * Composite terms sit with the family that should own them. That is why "jazz
	 * funk" is under Jazz, "funk rock" under Funk and "blues rock" under Blues.
	 */
	const GENRE_FAMILIES = {
		Jazz: [
			'jazz', 'hard bop', 'bebop', 'post-bop', 'cool jazz', 'modal jazz',
			'spiritual jazz', 'jazz funk', 'jazz fusion', 'free jazz', 'vocal jazz',
			'soul jazz', 'latin jazz', 'gypsy jazz', 'acid jazz', 'nu jazz',
			'smooth jazz', 'avant-garde jazz', 'contemporary jazz', 'swing', 'big band'
		],
		Soul: [
			'soul', 'neo soul', 'northern soul', 'southern soul', 'psychedelic soul',
			'blue-eyed soul', 'deep soul', 'modern soul', 'motown', 'quiet storm',
			'r&b', 'contemporary r&b', 'alternative r&b', 'rhythm and blues'
		],
		Funk: [
			'funk', 'p-funk', 'funk rock', 'electro-funk', 'afro-funk',
			'boogie', 'go-go'
		],
		'Hip hop': [
			'hip hop', 'rap', 'boom bap', 'jazz rap', 'conscious hip hop',
			'alternative hip hop', 'experimental hip hop', 'east coast hip hop',
			'west coast hip hop', 'southern hip hop', 'detroit hip hop', 'uk hip hop',
			'old school hip hop', 'gangster rap', 'grime', 'trap', 'drill'
		],
		Rock: [
			'rock', 'rock and roll', 'classic rock', 'alternative rock', 'indie rock',
			'art rock', 'garage rock', 'psychedelic rock', 'progressive rock',
			'krautrock', 'punk', 'post-punk', 'new wave', 'no wave', 'grunge',
			'shoegaze', 'emo', 'metal', 'hard rock', 'soft rock', 'britpop'
		],
		Electronic: [
			'electronic', 'electronica', 'electro', 'ambient', 'house', 'techno',
			'disco', 'dance', 'dance music', 'idm', 'synthpop', 'synth-pop',
			'trip hop', 'drum and bass', 'jungle', 'dubstep', 'trance', 'downtempo',
			'breakbeat', 'garage', 'uk garage', 'experimental electronic'
		],
		Blues: [
			'blues', 'delta blues', 'chicago blues', 'electric blues', 'country blues',
			'piedmont blues', 'texas blues', 'modern blues', 'blues rock'
		],
		Reggae: [
			'reggae', 'roots reggae', 'dub', 'ska', 'dancehall', 'rocksteady',
			'lovers rock', 'reggae fusion'
		],
		Folk: [
			'folk', 'traditional folk', 'contemporary folk', 'indie folk', 'folk rock',
			'singer-songwriter', 'americana', 'country', 'alt-country', 'bluegrass',
			'old-time', 'celtic', 'acoustic'
		],
		Classical: [
			'classical', 'baroque', 'romantic', 'modern classical',
			'contemporary classical', 'early music', 'opera', 'choral', 'chamber music',
			'orchestral', 'symphony', 'minimalism', 'neoclassical'
		],
		World: [
			'world', 'world music', 'afrobeat', 'afrobeat fusion', 'highlife',
			'african', 'west african', 'ethio-jazz', 'soukous', 'mbalax', 'rai',
			'latin', 'bossa nova', 'samba', 'tropicalia', 'mpb', 'cumbia', 'salsa',
			'son cubano', 'flamenco', 'fado', 'qawwali', 'indian classical',
			'carnatic', 'hindustani classical', 'arabic music', 'traditional music'
		],
		Pop: [
			'pop', 'indie pop', 'art pop', 'chamber pop', 'dream pop',
			'psychedelic pop', 'power pop', 'sophisti-pop', 'baroque pop',
			'adult contemporary', 'k-pop', 'j-pop'
		]
	};

	const API = 'https://api.spotify.com/v1/artists';
	const K = {
		database: 'hatify.genres',
		store: 'hatify.genres.artists'
	};
	const BATCH_SIZE = 50;
	const MAX_RATE_LIMIT_RETRIES = 4;
	let databasePromise = null;

	function failure(code, message, details = {}) {
		const error = new Error(message);
		error.name = 'HatifyGenreError';
		error.code = code;
		Object.assign(error, details);
		return error;
	}

	function reportFailure(error) {
		const code = error?.code || 'unexpected_failure';
		console.warn(`[Hatify genres: ${code}] ${error?.message || error}`, error);
	}

	function notify(callback, state) {
		if (typeof callback !== 'function') return;
		try {
			const result = callback(state);
			if (result && typeof result.catch === 'function') {
				result.catch((error) => reportFailure(failure(
					'progress_callback_failed',
					`Hatify's genre progress callback failed: ${error?.message || error}`,
					{ cause: error }
				)));
			}
		} catch (error) {
			reportFailure(failure(
				'progress_callback_failed',
				`Hatify's genre progress callback failed: ${error?.message || error}`,
				{ cause: error }
			));
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
				code, message, { cause: transaction.error }
			));
		});
	}

	function openDatabase() {
		if (databasePromise) return databasePromise;
		if (!globalThis.indexedDB) {
			return Promise.reject(failure(
				'cache_unavailable',
				'This browser does not provide IndexedDB, so Hatify cannot remember artist genres.'
			));
		}

		databasePromise = new Promise((resolve, reject) => {
			let request;
			try { request = indexedDB.open(K.database, 1); }
			catch (error) {
				databasePromise = null;
				reject(failure('cache_unavailable', 'Hatify could not open its genre cache.', { cause: error }));
				return;
			}

			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(K.store)) {
					request.result.createObjectStore(K.store, { keyPath: 'artistId' });
				}
			};
			request.onsuccess = () => {
				const database = request.result;
				database.onversionchange = () => {
					// Another Hatify tab cannot upgrade this cache while an old copy holds
					// it open. Closing here lets the newer copy repair the schema.
					database.close();
					databasePromise = null;
				};
				resolve(database);
			};
			request.onerror = () => {
				databasePromise = null;
				reject(failure('cache_unavailable', 'Hatify could not open its genre cache.', { cause: request.error }));
			};
			request.onblocked = () => {
				databasePromise = null;
				reject(failure(
					'cache_blocked',
					'Another Hatify tab is blocking the genre cache. Close the other tab and try again.'
				));
			};
		});

		return databasePromise;
	}

	function validCacheRecord(record, artistId) {
		return record
			&& record.artistId === artistId
			&& Array.isArray(record.tags)
			&& record.tags.every((tag) => typeof tag === 'string')
			&& typeof record.fetchedAt === 'string'
			&& Number.isFinite(Date.parse(record.fetchedAt));
	}

	async function readCachedArtists(artistIds) {
		if (!artistIds.length) return new Map();
		const database = await openDatabase();
		let store;
		try {
			store = database.transaction(K.store, 'readonly').objectStore(K.store);
		} catch (error) {
			throw failure('cache_read_failed', 'Hatify could not start reading its genre cache.', { cause: error });
		}

		const records = await Promise.all(artistIds.map((artistId) => {
			let request;
			try { request = store.get(artistId); }
			catch (error) {
				return Promise.reject(failure(
					'cache_read_failed',
					`Hatify could not read the cached genres for artist ${artistId}.`,
					{ artistId, cause: error }
				));
			}
			return requestResult(
				request,
				'cache_read_failed',
				`Hatify could not read the cached genres for artist ${artistId}.`
			);
		}));

		const found = new Map();
		for (let index = 0; index < records.length; index++) {
			const record = records[index];
			if (record === undefined) continue;
			const artistId = artistIds[index];
			if (!validCacheRecord(record, artistId)) {
				reportFailure(failure(
					'cache_record_invalid',
					`Hatify ignored an unreadable cached genre record for artist ${artistId}.`,
					{ artistId }
				));
				continue;
			}
			found.set(artistId, record);
		}
		return found;
	}

	async function writeCachedArtists(records) {
		if (!records.length) return;
		const database = await openDatabase();
		let transaction, store;
		try {
			transaction = database.transaction(K.store, 'readwrite');
			store = transaction.objectStore(K.store);
		} catch (error) {
			throw failure('cache_write_failed', 'Hatify could not start saving artist genres.', { cause: error });
		}
		const committed = transactionResult(
			transaction,
			'cache_write_failed',
			'Hatify fetched artist genres but could not save them for next time.'
		);
		const writes = records.map((record) => {
			let request;
			try { request = store.put(record); }
			catch (error) {
				return Promise.reject(failure(
					'cache_write_failed',
					`Hatify could not save genres for artist ${record.artistId}.`,
					{ artistId: record.artistId, cause: error }
				));
			}
			return requestResult(
				request,
				'cache_write_failed',
				`Hatify could not save genres for artist ${record.artistId}.`
			);
		});
		// A successful put is not a successful save. IndexedDB can still abort the
		// transaction at commit time when the iPad has no storage left.
		await Promise.all([...writes, committed]);
	}

	function retryDelay(response) {
		const value = response.headers.get('Retry-After');
		const seconds = Number(value);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
		const date = Date.parse(value);
		if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
		return 1000;
	}

	const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

	async function responseJSON(response) {
		try { return await response.json(); }
		catch (error) {
			throw failure(
				'spotify_response_invalid',
				'Spotify returned artist genres Hatify could not read.',
				{ status: response.status, cause: error }
			);
		}
	}

	async function fetchArtistBatch(artistIds, onProgress, loaded, total) {
		const url = API + '?' + new URLSearchParams({ ids: artistIds.join(',') });
		for (let attempt = 0; ; attempt++) {
			if (typeof globalThis.refreshAccessToken !== 'function') {
				throw failure(
					'auth_helper_missing',
					'Load Hatify\'s library module before its genre module so Spotify login renewal is available.'
				);
			}

			let access;
			try { access = await globalThis.refreshAccessToken(); }
			catch (error) {
				throw failure(
					'auth_refresh_failed',
					`Hatify could not refresh the Spotify login before fetching genres: ${error?.message || error}`,
					{ cause: error }
				);
			}
			if (!access) {
				throw failure('must_log_in_again', 'Spotify needs Harry to log in again before Hatify can fetch genres.', {
					state: 'must_log_in_again', requiresLogin: true
				});
			}

			let response;
			try {
				response = await fetch(url, { headers: { Authorization: 'Bearer ' + access } });
			} catch (error) {
				throw failure('offline', 'Hatify could not reach Spotify for artist genres. The device may be offline.', {
					cause: error
				});
			}

			if (response.status === 429) {
				const delay = retryDelay(response);
				if (attempt >= MAX_RATE_LIMIT_RETRIES) {
					throw failure(
						'rate_limited',
						'Spotify is still asking Hatify to slow down. The shelf will stay available without new genre data.',
						{ retryAfter: delay }
					);
				}
				notify(onProgress, { phase: 'rate_limit', loaded, total, retryAfter: delay });
				// Retry-After is Spotify's instruction, not a hint. Asking again sooner
				// can extend the lockout and turn five small requests into a broken app.
				await wait(delay);
				continue;
			}
			if (response.status === 401) {
				throw failure(
					'spotify_auth_rejected',
					'Spotify rejected Hatify\'s access token while fetching artist genres.',
					{ status: response.status, state: 'must_log_in_again', requiresLogin: true }
				);
			}
			if (!response.ok) {
				throw failure(
					'spotify_request_failed',
					`Spotify could not load artist genres (${response.status}).`,
					{ status: response.status }
				);
			}

			const data = await responseJSON(response);
			if (!Array.isArray(data?.artists)) {
				throw failure('spotify_response_invalid', 'Spotify returned an artist response Hatify cannot understand.');
			}

			const requested = new Set(artistIds);
			const returned = new Map();
			for (const artist of data.artists) {
				if (!artist || !requested.has(artist.id)) continue;
				if (!Array.isArray(artist.genres) || !artist.genres.every((tag) => typeof tag === 'string')) {
					reportFailure(failure(
						'artist_record_invalid',
						`Spotify returned unreadable genres for artist ${artist.id}.`,
						{ artistId: artist.id }
					));
					continue;
				}
				returned.set(artist.id, {
					artistId: artist.id,
					tags: [...artist.genres],
					fetchedAt: new Date().toISOString()
				});
			}

			for (const artistId of artistIds) {
				if (returned.has(artistId)) continue;
				reportFailure(failure(
					'artist_unavailable',
					`Spotify did not return genre data for artist ${artistId}.`,
					{ artistId }
				));
			}
			return [...returned.values()];
		}
	}

	function normalizeForMatch(value) {
		return value.toLowerCase().replace(/[\/_-]+/g, ' ').replace(/\s+/g, ' ').trim();
	}

	function familyForTags(tags) {
		if (!tags.length) return 'No Spotify tags';
		let strongest = null;
		let strongestScore = 0;

		for (const [family, terms] of Object.entries(GENRE_FAMILIES)) {
			let score = 0;
			for (const rawTag of tags) {
				const tag = normalizeForMatch(rawTag);
				let tagScore = 0;
				for (const rawTerm of terms) {
					const term = normalizeForMatch(rawTerm);
					if (tag === term) tagScore = Math.max(tagScore, 3);
					else if (` ${tag} `.includes(` ${term} `)) tagScore = Math.max(tagScore, 1);
				}
				score += tagScore;
			}
			if (score > strongestScore) {
				strongest = family;
				strongestScore = score;
			}
		}

		return strongest || 'Other Spotify genres';
	}

	function albumsByPrimaryArtist(albums) {
		const byArtist = new Map();
		const usableAlbums = [];
		for (let position = 0; position < albums.length; position++) {
			const album = albums[position];
			if (!album || typeof album.id !== 'string' || !album.id) {
				reportFailure(failure(
					'album_record_invalid',
					`Hatify cannot attach genres to the album at shelf position ${position + 1} because it has no album id.`,
					{ position }
				));
				continue;
			}
			const artistId = Array.isArray(album.artist_ids)
				&& typeof album.artist_ids[0] === 'string'
				&& album.artist_ids[0]
				? album.artist_ids[0]
				: null;
			usableAlbums.push({ albumId: album.id, artistId });
			if (!artistId) {
				reportFailure(failure(
					'primary_artist_id_missing',
					`Album ${album.id} has no primary Spotify artist id, so Hatify will not guess its genre.`,
					{ albumId: album.id }
				));
				continue;
			}
			if (!byArtist.has(artistId)) byArtist.set(artistId, []);
			byArtist.get(artistId).push(album.id);
		}
		return { byArtist, usableAlbums };
	}

	function resultForAlbums(usableAlbums, records) {
		const result = new Map();
		for (const { albumId, artistId } of usableAlbums) {
			if (!artistId) {
				result.set(albumId, { family: 'No artist ID', tags: [], artistId: null });
				continue;
			}
			const record = records.get(artistId);
			if (!record) {
				result.set(albumId, { family: 'Genre unavailable', tags: [], artistId });
				continue;
			}
			result.set(albumId, {
				family: familyForTags(record.tags),
				tags: [...record.tags],
				artistId
			});
		}
		return result;
	}

	async function loadGenres(albums, options = {}) {
		if (!Array.isArray(albums)) {
			throw failure('invalid_albums', 'loadGenres expects an array of Hatify albums.');
		}
		if (!options || typeof options !== 'object') {
			throw failure('invalid_options', 'loadGenres expects its second argument to be an options object.');
		}
		const { onProgress } = options;
		if (onProgress !== undefined && typeof onProgress !== 'function') {
			throw failure('invalid_on_progress', 'loadGenres onProgress must be a function.');
		}

		const { byArtist, usableAlbums } = albumsByPrimaryArtist(albums);
		const artistIds = [...byArtist.keys()];
		const total = artistIds.length;
		let records = new Map();

		try { records = await readCachedArtists(artistIds); }
		catch (error) {
			// A blocked or full cache must not become a blocked shelf. Fetch the tags
			// for this run and report exactly why they will not survive the next one.
			reportFailure(error);
			notify(onProgress, {
				phase: 'cache_failed', loaded: 0, total,
				error: { code: error.code, message: error.message }
			});
		}

		notify(onProgress, { phase: 'cache', loaded: records.size, total });
		const missing = artistIds.filter((artistId) => !records.has(artistId));
		const fetched = [];
		let fetchFailure = null;

		for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
			const batch = missing.slice(offset, offset + BATCH_SIZE);
			let batchRecords;
			try {
				batchRecords = await fetchArtistBatch(
					batch, onProgress, records.size + fetched.length, total
				);
			} catch (error) {
				fetchFailure = error;
				reportFailure(error);
				break;
			}
			for (const record of batchRecords) {
				records.set(record.artistId, record);
				fetched.push(record);
			}
			notify(onProgress, {
				phase: 'fetch', loaded: records.size, total,
				batch: Math.floor(offset / BATCH_SIZE) + 1,
				batches: Math.ceil(missing.length / BATCH_SIZE)
			});
		}

		if (fetched.length) {
			try { await writeCachedArtists(fetched); }
			catch (error) {
				reportFailure(error);
				notify(onProgress, {
					phase: 'cache_write_failed', loaded: records.size, total,
					error: { code: error.code, message: error.message }
				});
			}
		}

		const unavailable = artistIds.filter((artistId) => !records.has(artistId)).length;
		if (fetchFailure) {
			notify(onProgress, {
				phase: 'degraded', loaded: records.size, total, unavailable,
				error: { code: fetchFailure.code, message: fetchFailure.message }
			});
		} else {
			notify(onProgress, { phase: 'complete', loaded: records.size, total, unavailable });
		}

		return resultForAlbums(usableAlbums, records);
	}

	async function clearGenreCache() {
		const database = await openDatabase();
		let transaction, request;
		try {
			transaction = database.transaction(K.store, 'readwrite');
			request = transaction.objectStore(K.store).clear();
		} catch (error) {
			throw failure('cache_clear_failed', 'Hatify could not start clearing its genre cache.', { cause: error });
		}
		const cleared = transactionResult(
			transaction,
			'cache_clear_failed',
			'Hatify could not clear its genre cache.'
		);
		await Promise.all([
			requestResult(request, 'cache_clear_failed', 'Hatify could not clear its genre cache.'),
			cleared
		]);
	}

	globalThis.loadGenres = loadGenres;
	globalThis.clearGenreCache = clearGenreCache;
	globalThis.GENRE_FAMILIES = GENRE_FAMILIES;
})();
