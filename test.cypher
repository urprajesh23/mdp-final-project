MATCH (n:Transformer) 
RETURN n.name, n.status, n.current_load 
ORDER BY n.name