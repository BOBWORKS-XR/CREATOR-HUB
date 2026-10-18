//! Finite GUI connection protocol, not a backend RPC or a settings authority.
pub(crate) const PACKET: usize = 16 * 1024;
pub(crate) const LIMIT: usize = 2 * 1024 * 1024;
const HEADER: usize = 60;
const PAYLOAD: usize = PACKET - HEADER;
const MAGIC: &[u8; 8] = b"CWGUI001";
pub(crate) const MAX_ID: u64 = (1 << 53) - 1;
const INFLIGHT: usize = 32;
pub(crate) type Result<T> = std::result::Result<T, &'static str>;

#[derive(Default)]
pub(crate) struct Requests {
    pub last: u64,
    pub pending: std::collections::BTreeSet<u64>,
}
impl Requests {
    pub fn add(&mut self, id: u64) -> Result<()> {
        if id
            != self
                .last
                .checked_add(1)
                .filter(|id| *id <= MAX_ID)
                .ok_or("gui-request-id-exhausted")?
            || self.pending.len() >= INFLIGHT
        {
            return Err("gui-request-order-or-capacity");
        }
        self.pending.insert(id);
        self.last = id;
        Ok(())
    }
    pub fn complete(&mut self, id: u64) -> Result<()> {
        if !self.pending.remove(&id) {
            return Err("gui-response-unknown-or-replayed");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum Kind {
    Ready,
    Challenge,
    Accepted,
    Request,
    Response,
    Event,
    Close,
    Closed,
    Release,
}

impl Kind {
    fn parse(byte: u8) -> Result<Self> {
        match byte {
            0 => Ok(Self::Ready),
            1 => Ok(Self::Challenge),
            2 => Ok(Self::Accepted),
            3 => Ok(Self::Request),
            4 => Ok(Self::Response),
            5 => Ok(Self::Event),
            6 => Ok(Self::Close),
            7 => Ok(Self::Closed),
            8 => Ok(Self::Release),
            _ => Err("gui-message-kind"),
        }
    }
}

/// Opaque application envelope. The Core must decode its finite command enum
/// before dispatch; possession of these bytes is never permission to do work.
pub struct GuiRequest {
    pub(crate) id: u64,
    pub(crate) body: Vec<u8>,
    pub(crate) session: [u8; 32],
}
impl std::fmt::Debug for GuiRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuiRequest")
            .field("id", &self.id)
            .field("payload_bytes", &self.body.len())
            .finish_non_exhaustive()
    }
}
impl GuiRequest {
    pub fn id(&self) -> u64 {
        self.id
    }
    pub fn payload(&self) -> &[u8] {
        &self.body
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum GuiMessage {
    Response { id: u64, payload: Vec<u8> },
    Event { payload: Vec<u8> },
    Closed,
}

pub(crate) struct Wire {
    pub kind: Kind,
    pub id: u64,
    pub session: [u8; 32],
    pub body: Vec<u8>,
}

pub(crate) fn frames(kind: Kind, id: u64, session: [u8; 32], body: &[u8]) -> Result<Vec<Vec<u8>>> {
    if body.len() > LIMIT || id > MAX_ID {
        return Err("gui-message-bound");
    }
    let count = body.len().div_ceil(PAYLOAD).max(1);
    let mut result = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * PAYLOAD;
        let part = &body[start..body.len().min(start + PAYLOAD)];
        let mut frame = Vec::with_capacity(HEADER + part.len());
        frame.extend_from_slice(MAGIC);
        frame.extend_from_slice(&1u16.to_le_bytes());
        frame.extend_from_slice(&[kind as u8, 0]);
        frame.extend_from_slice(&id.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&(index as u16).to_le_bytes());
        frame.extend_from_slice(&(count as u16).to_le_bytes());
        frame.extend_from_slice(&session);
        frame.extend_from_slice(part);
        result.push(frame);
    }
    Ok(result)
}

#[derive(Default)]
pub(crate) struct Assembly {
    message: Option<Wire>,
    length: usize,
    count: usize,
    next: usize,
}
impl Assembly {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Option<Wire>> {
        if bytes.len() < HEADER
            || bytes.len() > PACKET
            || &bytes[..8] != MAGIC
            || bytes[8..10] != 1u16.to_le_bytes()
            || bytes[11] != 0
        {
            return Err("gui-frame-header");
        }
        let kind = Kind::parse(bytes[10])?;
        let id = u64::from_le_bytes(bytes[12..20].try_into().map_err(|_| "gui-frame-id")?);
        let length =
            u32::from_le_bytes(bytes[20..24].try_into().map_err(|_| "gui-frame-length")?) as usize;
        let index =
            u16::from_le_bytes(bytes[24..26].try_into().map_err(|_| "gui-frame-index")?) as usize;
        let count =
            u16::from_le_bytes(bytes[26..28].try_into().map_err(|_| "gui-frame-count")?) as usize;
        let session: [u8; 32] = bytes[28..60].try_into().map_err(|_| "gui-frame-session")?;
        if id > MAX_ID
            || length > LIMIT
            || count != length.div_ceil(PAYLOAD).max(1)
            || index != self.next
            || index >= count
        {
            return Err("gui-chunk-order-or-bound");
        }
        let part = length.saturating_sub(index * PAYLOAD).min(PAYLOAD);
        if bytes.len() != HEADER + part {
            return Err("gui-chunk-size");
        }
        if let Some(message) = &self.message {
            if message.kind != kind
                || message.id != id
                || message.session != session
                || self.length != length
                || self.count != count
            {
                return Err("gui-chunk-identity");
            }
        } else {
            self.length = length;
            self.count = count;
            self.message = Some(Wire {
                kind,
                id,
                session,
                body: Vec::with_capacity(length),
            });
        }
        self.message
            .as_mut()
            .ok_or("gui-assembly")?
            .body
            .extend_from_slice(&bytes[HEADER..]);
        self.next += 1;
        if self.next == count {
            let result = self.message.take().ok_or("gui-assembly")?;
            *self = Self::default();
            Ok(Some(result))
        } else {
            Ok(None)
        }
    }
}

pub(crate) fn exact(message: &Wire, kind: Kind, id: u64, session: [u8; 32]) -> Result<()> {
    if message.kind != kind
        || message.id != id
        || message.session != session
        || !message.body.is_empty()
    {
        return Err("gui-message-order-or-shape");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_debug_does_not_disclose_payload_or_session_challenge() {
        let request = GuiRequest {
            id: 1,
            body: b"private configuration".to_vec(),
            session: [37; 32],
        };
        let text = format!("{request:?}");
        assert!(text.contains("payload_bytes: 21"));
        assert!(!text.contains("private"));
        assert!(!text.contains("session"));
    }
    #[test]
    fn thirty_two_pending_reads_allow_out_of_order_control_responses() {
        let mut r = Requests::default();
        for id in 1..=32 {
            r.add(id).unwrap();
        }
        assert!(r.add(33).is_err());
        r.complete(32).unwrap();
        r.add(33).unwrap();
        assert!(r.add(33).is_err());
        assert!(r.complete(32).is_err());
        for id in 1..32 {
            r.complete(id).unwrap();
        }
        r.complete(33).unwrap();
        assert!(r.pending.is_empty());
    }
    #[test]
    fn ids_cannot_replay_skip_or_overflow() {
        let mut r = Requests::default();
        assert!(r.add(0).is_err());
        assert!(r.add(2).is_err());
        r.last = MAX_ID;
        assert!(r.add(MAX_ID + 1).is_err());
        r.last = u64::MAX;
        assert!(r.add(0).is_err());
    }
    #[test]
    fn exact_chunk_boundaries_roundtrip_without_packets_over_16k() {
        for size in [0, 1, PAYLOAD, PAYLOAD + 1, LIMIT] {
            let bytes = vec![42; size];
            let encoded = frames(Kind::Response, MAX_ID, [7; 32], &bytes).unwrap();
            let mut a = Assembly::default();
            let mut result = None;
            for frame in &encoded {
                assert!(frame.len() <= PACKET);
                result = a.push(frame).unwrap();
            }
            let result = result.unwrap();
            assert_eq!(result.body, bytes);
            assert_eq!(result.id, MAX_ID);
            assert_eq!(result.session, [7; 32]);
            assert_eq!(result.kind, Kind::Response);
        }
        assert!(frames(Kind::Response, 1, [1; 32], &vec![0; LIMIT + 1]).is_err());
        assert!(frames(Kind::Request, MAX_ID + 1, [1; 32], &[]).is_err());
    }
    #[test]
    fn malformed_headers_versions_counts_and_truncation_refuse() {
        let good = frames(Kind::Request, 1, [1; 32], &[]).unwrap().remove(0);
        for index in [0, 8, 9, 10, 11, 19, 20, 21, 22, 23, 24, 25, 26, 27] {
            let mut bad = good.clone();
            bad[index] = 255;
            assert!(Assembly::default().push(&bad).is_err(), "byte {index}");
        }
        for size in 0..HEADER {
            assert!(Assembly::default().push(&good[..size]).is_err());
        }
        let mut bad = good.clone();
        bad.push(0);
        assert!(Assembly::default().push(&bad).is_err());
        assert!(Assembly::default().push(&vec![0; PACKET + 1]).is_err());
    }
    #[test]
    fn duplicates_gaps_and_changed_chunk_identity_refuse() {
        let frames = frames(Kind::Response, 1, [1; 32], &vec![5; PAYLOAD + 1]).unwrap();
        assert!(Assembly::default().push(&frames[1]).is_err());
        for index in [10, 12, 20, 26, 28] {
            let mut a = Assembly::default();
            assert!(a.push(&frames[0]).unwrap().is_none());
            let mut bad = frames[1].clone();
            bad[index] ^= 1;
            assert!(a.push(&bad).is_err());
        }
        let mut a = Assembly::default();
        a.push(&frames[0]).unwrap();
        assert!(a.push(&frames[0]).is_err());
    }
    #[test]
    fn control_schema_rejects_unknown_kind_session_id_and_extra_body() {
        let mut wire = Wire {
            kind: Kind::Accepted,
            id: 0,
            session: [1; 32],
            body: vec![],
        };
        assert!(exact(&wire, Kind::Accepted, 0, [1; 32]).is_ok());
        assert!(exact(&wire, Kind::Accepted, 1, [1; 32]).is_err());
        assert!(exact(&wire, Kind::Accepted, 0, [2; 32]).is_err());
        assert!(exact(&wire, Kind::Closed, 0, [1; 32]).is_err());
        wire.body.push(0);
        assert!(exact(&wire, Kind::Accepted, 0, [1; 32]).is_err());
    }
}
