pub const SIZE: usize = 48;
pub const MAGIC: &[u8; 8] = b"CWFLPK01";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Ready = 0,
    Challenge = 1,
    Echo = 2,
    Close = 3,
    Closed = 4,
    Release = 5,
}

pub fn packet(kind: Kind, nonce: [u8; 32]) -> [u8; SIZE] {
    let mut bytes = [0; SIZE];
    bytes[..8].copy_from_slice(MAGIC);
    bytes[8] = kind as u8;
    bytes[16..].copy_from_slice(&nonce);
    bytes
}

pub fn matches(bytes: &[u8], kind: Kind, nonce: [u8; 32]) -> bool {
    bytes == packet(kind, nonce)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_fixed_protocol_rejects_other_operations_and_replays() {
        let nonce = [17; 32];
        let good = packet(Kind::Echo, nonce);
        assert!(matches(&good, Kind::Echo, nonce));
        assert!(!matches(&good[..47], Kind::Echo, nonce));
        assert!(!matches(&good, Kind::Challenge, nonce));
        assert!(!matches(&good, Kind::Echo, [18; 32]));
        for index in 0..SIZE {
            let mut bad = good;
            bad[index] ^= 1;
            assert!(!matches(&bad, Kind::Echo, nonce));
        }
        assert!(!matches(b"GetStatus", Kind::Echo, nonce));
    }
}
