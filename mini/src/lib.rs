pub fn x() -> u32 { 1 }
#[cfg(test)]
mod tests {
    #[test]
    fn t() { assert_eq!(super::x(), 1); }
}
